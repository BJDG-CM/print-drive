import { createHash } from 'node:crypto';

export async function pollPagesDeployment(options) {
    const {
        pagesUrl,
        manifestSha256,
        objectPath,
        fetchFunction = globalThis.fetch,
        delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
        timeoutMs = 180000,
        intervalMs = 5000,
        now = Date.now
    } = options;
    if (!/^https:\/\//.test(pagesUrl || '')) return { status: 'failed', reason: 'PAGES_URL_NOT_CONFIGURED' };
    if (!/^[0-9a-f]{64}$/.test(manifestSha256 || '')) throw new Error('Expected manifest SHA-256 is invalid.');
    const base = pagesUrl.endsWith('/') ? pagesUrl : `${pagesUrl}/`;
    const startedAt = now();
    let lastError = null;
    while (now() - startedAt <= timeoutMs) {
        try {
            const metaResponse = await fetchFunction(new URL(`build-meta.json?verify=${Date.now()}`, base), { cache: 'no-store' });
            if (!metaResponse.ok) throw new Error(`build-meta HTTP ${metaResponse.status}`);
            const meta = await metaResponse.json();
            if (meta?.vault?.manifestSha256 === manifestSha256) {
                const manifestResponse = await fetchFunction(new URL(`files/manifest.enc?verify=${Date.now()}`, base), { cache: 'no-store' });
                if (!manifestResponse.ok) throw new Error(`manifest HTTP ${manifestResponse.status}`);
                const actual = createHash('sha256').update(new Uint8Array(await manifestResponse.arrayBuffer())).digest('hex');
                if (actual !== manifestSha256) throw new Error('served manifest hash mismatch');
                if (objectPath) {
                    const objectResponse = await fetchFunction(new URL(`${objectPath.replace(/^files\//, 'files/')}?verify=${Date.now()}`, base), { cache: 'no-store' });
                    if (!objectResponse.ok) throw new Error(`object HTTP ${objectResponse.status}`);
                    await objectResponse.body?.cancel?.();
                }
                return { status: 'confirmed', buildId: meta.buildId, manifestSha256 };
            }
            lastError = `served manifest is ${meta?.vault?.manifestSha256 || 'unknown'}`;
        } catch (error) {
            lastError = error.message;
        }
        if (now() - startedAt + intervalMs > timeoutMs) break;
        await delay(intervalMs);
    }
    return { status: 'pending', reason: lastError || 'deployment timeout', timeoutMs };
}
