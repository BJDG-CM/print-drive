import errno
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
import time
from pathlib import Path

try:
    from watchdog.events import FileSystemEventHandler
    from watchdog.observers import Observer
except ImportError:  # Tests and syntax checks can import this module without watchdog.
    FileSystemEventHandler = object
    Observer = None


DEBOUNCE_SECONDS = 2.5
PUSH_RETRIES = 2
PUSH_RETRY_BASE_SECONDS = 2
PUSH_PENDING_RETRY_SECONDS = 60
STABILITY_INTERVAL_SECONDS = 0.6
STABILITY_REQUIRED_SNAPSHOTS = 3
STABILITY_TIMEOUT_SECONDS = 30
SYNC_LOCK_STALE_SECONDS = 30 * 60
DEFAULT_PASSPHRASE_FILE = ".print-drive-passphrase"
ENCRYPT_SCRIPT_NAME = "encrypt_files.mjs"
SCRIPT_DIR = Path(__file__).resolve().parent
CONFIG_CLI = SCRIPT_DIR / "scripts" / "config_cli.mjs"

IGNORED_NAMES = {
    ".DS_Store",
    "Thumbs.db",
    "desktop.ini",
}
IGNORED_SUFFIXES = (
    ".tmp",
    ".temp",
    ".crdownload",
    ".download",
    ".part",
    ".partial",
    ".swp",
    ".sync",
)
IGNORED_PREFIXES = (
    ".",
    "~$",
    "~",
)
PERMANENT_PUSH_MARKERS = (
    "non-fast-forward",
    "fetch first",
    "rejected",
    "permission denied",
    "authentication failed",
    "repository not found",
    "could not read from remote repository",
    "no upstream branch",
)


class SyncError(RuntimeError):
    pass


class GitContextError(SyncError):
    pass


class PushPendingError(SyncError):
    pass


class NonFastForwardError(PushPendingError):
    pass


def validate_dependencies():
    missing = []
    for command in ("node", "git"):
        if shutil.which(command) is None:
            missing.append(command)
    if Observer is None:
        missing.append("watchdog (python package)")

    if missing:
        print(f"Missing required dependency/dependencies: {', '.join(missing)}.")
        print("Install Python packages with `python -m pip install -r requirements.txt` and verify Node/Git are on PATH.")
        sys.exit(1)


def get_project_root():
    value = os.environ.get("PRINT_DRIVE_ROOT")
    return Path(value).expanduser().resolve() if value else SCRIPT_DIR


def resolve_project_path(project_root, env_name, default_value):
    value = os.environ.get(env_name, default_value)
    path_value = Path(value).expanduser()
    return path_value.resolve() if path_value.is_absolute() else (project_root / path_value).resolve()


def load_runtime_config(project_root):
    args = [
        "node",
        str(CONFIG_CLI),
        "resolve",
        "--json",
        "--project-root",
        str(project_root),
        "--require-directories",
    ]
    config_path = os.environ.get("PRINT_DRIVE_CONFIG")
    if config_path:
        args.extend(["--config", config_path])

    result = subprocess.run(
        args,
        cwd=project_root,
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if result.returncode != 0:
        raise SyncError(result.stderr.strip() or result.stdout.strip() or "Config resolution failed.")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise SyncError(f"Config resolver returned invalid JSON: {error}") from error


def display_path(project_root, path_value):
    try:
        return str(Path(path_value).relative_to(project_root))
    except ValueError:
        return str(path_value)


class RepositorySyncLock:
    def __init__(self, repository_root, stale_seconds=SYNC_LOCK_STALE_SECONDS):
        repository_root = Path(repository_root)
        git_path_result = subprocess.run(
            ["git", "rev-parse", "--git-path", "print-drive-sync.lock"],
            cwd=repository_root,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if git_path_result.returncode == 0 and git_path_result.stdout.strip():
            candidate = Path(git_path_result.stdout.strip())
            self.path = candidate if candidate.is_absolute() else repository_root / candidate
        else:
            self.path = repository_root / ".git" / "print-drive-sync.lock"
        self.stale_seconds = stale_seconds
        self.acquired = False

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for attempt in range(2):
            try:
                descriptor = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(descriptor, "w", encoding="utf-8") as lock_file:
                    lock_file.write(json.dumps({"pid": os.getpid(), "createdAt": time.time()}))
                self.acquired = True
                return True
            except FileExistsError:
                if attempt == 0 and self._remove_if_stale():
                    continue
                return False
        return False

    def _remove_if_stale(self):
        try:
            age = time.time() - self.path.stat().st_mtime
            if age <= self.stale_seconds:
                return False
            try:
                owner = json.loads(self.path.read_text(encoding="utf-8"))
                owner_pid = owner.get("pid") if isinstance(owner, dict) else None
            except (OSError, UnicodeError, json.JSONDecodeError):
                owner_pid = None
            if isinstance(owner_pid, int) and process_is_running(owner_pid):
                return False
            self.path.unlink()
            print("Removed a stale Print Drive sync lock after verifying its age and inactive owner.")
            return True
        except FileNotFoundError:
            return True
        except OSError:
            return False

    def release(self):
        if not self.acquired:
            return
        try:
            self.path.unlink()
        except FileNotFoundError:
            pass
        finally:
            self.acquired = False

    def __enter__(self):
        if not self.acquire():
            raise SyncError("Another Print Drive sync process owns the repository lock.")
        return self

    def __exit__(self, _error_type, _error, _traceback):
        self.release()


class SyncHandler(FileSystemEventHandler):
    def __init__(
        self,
        base_dir,
        private_dir,
        public_dir,
        passphrase_file,
        allowed_branch="main",
        remote="origin",
        debounce_seconds=DEBOUNCE_SECONDS,
        push_retries=PUSH_RETRIES,
    ):
        self.base_dir = Path(base_dir).resolve()
        self.public_dir = Path(public_dir).resolve()
        self.private_dir = Path(private_dir).resolve()
        self.passphrase_file = Path(passphrase_file).resolve()
        validate_passphrase_path(self.base_dir, self.private_dir, self.public_dir, self.passphrase_file)
        self.allowed_branch = allowed_branch
        self.remote = remote
        self.encrypt_script = SCRIPT_DIR / ENCRYPT_SCRIPT_NAME
        self.debounce_seconds = debounce_seconds
        self.push_retries = push_retries
        self.timer = None
        self.timer_lock = threading.Lock()
        self.sync_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.needs_encrypt = False
        self.change_generation = 0
        self.stopping = False

    def on_any_event(self, event):
        path_value = Path(event.src_path)
        if self.should_ignore(path_value):
            return

        with self.state_lock:
            self.needs_encrypt = True
            self.change_generation += 1
        print(f"Detected a source {event.event_type} event; waiting for the write to finish.")
        self.schedule_sync()

    def should_ignore(self, path_value):
        name = path_value.name
        lower_name = name.lower()
        if name in IGNORED_NAMES:
            return True
        if any(name.startswith(prefix) for prefix in IGNORED_PREFIXES):
            return True
        if lower_name.endswith(IGNORED_SUFFIXES):
            return True

        try:
            file_stat = os.stat(path_value, follow_symlinks=False)
            attributes = getattr(file_stat, "st_file_attributes", 0)
            if attributes & getattr(stat, "FILE_ATTRIBUTE_HIDDEN", 0):
                return True
        except (FileNotFoundError, OSError):
            pass
        return False

    def request_initial_reconcile(self):
        with self.state_lock:
            self.needs_encrypt = True
            self.change_generation += 1
        self.schedule_sync(delay=0.1)

    def schedule_sync(self, delay=None):
        with self.timer_lock:
            if self.stopping:
                return
            if self.timer is not None:
                self.timer.cancel()
            actual_delay = self.debounce_seconds if delay is None else delay
            self.timer = threading.Timer(actual_delay, self.run_scheduled_sync)
            self.timer.daemon = True
            self.timer.start()
            print(f"Sync scheduled in {actual_delay:.1f}s.")

    def cancel_pending_sync(self):
        with self.timer_lock:
            self.stopping = True
            if self.timer is not None:
                self.timer.cancel()
                self.timer = None

    def run_scheduled_sync(self):
        with self.timer_lock:
            self.timer = None
        if self.stopping:
            return
        if not self.sync_lock.acquire(blocking=False):
            print("Sync is already running. Scheduling one more pass.")
            self.schedule_sync()
            return

        repository_lock = RepositorySyncLock(self.base_dir)
        try:
            if not repository_lock.acquire():
                print("Another Print Drive process is syncing. Retrying after the debounce window.")
                self.schedule_sync()
                return
            self.run_sync_pass()
        except NonFastForwardError as error:
            print(str(error))
        except PushPendingError as error:
            print(str(error))
            if not self.stopping:
                print(f"Pending push will be retried in {PUSH_PENDING_RETRY_SECONDS}s.")
                self.schedule_sync(delay=PUSH_PENDING_RETRY_SECONDS)
        except Exception as error:
            print(f"Sync pass failed safely: {error}")
            with self.state_lock:
                retry_encrypt = self.needs_encrypt
            if retry_encrypt:
                self.schedule_sync(delay=max(self.debounce_seconds, 5.0))
        finally:
            repository_lock.release()
            self.sync_lock.release()

        with self.state_lock:
            pending = self.needs_encrypt
        if pending and not self.stopping:
            self.schedule_sync()

    def run_sync_pass(self):
        with self.state_lock:
            should_encrypt = self.needs_encrypt
            generation = self.change_generation

        if should_encrypt:
            self.prepare_remote_base()
            self.wait_for_source_stability()
            encrypted = self.encrypt_private_files()
            if encrypted:
                with self.state_lock:
                    if self.change_generation == generation:
                        self.needs_encrypt = False
            else:
                # A new source event will retry. Avoid a tight loop when the local
                # passphrase has not been configured yet.
                with self.state_lock:
                    if self.change_generation == generation:
                        self.needs_encrypt = False

        self.sync_to_github()

    def wait_for_source_stability(self):
        deadline = time.monotonic() + STABILITY_TIMEOUT_SECONDS
        stable_count = 0
        previous = None
        while time.monotonic() < deadline:
            snapshot = self.source_snapshot()
            if snapshot == previous:
                stable_count += 1
                if stable_count >= STABILITY_REQUIRED_SNAPSHOTS:
                    return snapshot
            else:
                previous = snapshot
                stable_count = 0
            time.sleep(STABILITY_INTERVAL_SECONDS)
        raise SyncError("Source files did not become stable before the timeout; no encryption or Git commit was attempted.")

    def source_snapshot(self):
        snapshot = []
        unavailable_cloud_files = 0
        for directory, directory_names, file_names in os.walk(self.private_dir, followlinks=False):
            directory_path = Path(directory)
            retained_directories = []
            for name in directory_names:
                path_value = directory_path / name
                if self.should_ignore(path_value):
                    continue
                if path_value.is_symlink():
                    raise SyncError(f"Symbolic links are not allowed in the source workspace: {path_value}")
                retained_directories.append(name)
            directory_names[:] = retained_directories
            for name in file_names:
                path_value = directory_path / name
                if self.should_ignore(path_value):
                    continue
                if path_value.is_symlink():
                    raise SyncError(f"Symbolic links are not allowed in the source workspace: {path_value}")
                file_stat = path_value.stat(follow_symlinks=False)
                attributes = getattr(file_stat, "st_file_attributes", 0)
                offline_flags = (
                    getattr(stat, "FILE_ATTRIBUTE_OFFLINE", 0)
                    | getattr(stat, "FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS", 0)
                    | getattr(stat, "FILE_ATTRIBUTE_RECALL_ON_OPEN", 0)
                )
                if attributes & offline_flags:
                    unavailable_cloud_files += 1
                relative = path_value.relative_to(self.private_dir).as_posix()
                snapshot.append((relative, file_stat.st_size, file_stat.st_mtime_ns))
        if unavailable_cloud_files:
            raise SyncError(
                f"{unavailable_cloud_files} OneDrive/cloud file(s) are not fully available locally. "
                "Mark them available offline before syncing."
            )
        return tuple(sorted(snapshot))

    def run_command(self, args, check=True):
        return subprocess.run(
            args,
            cwd=self.base_dir,
            check=check,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    def run_git(self, args, check=True):
        return self.run_command(["git", *args], check=check)

    def git_pathspec(self):
        try:
            relative = self.public_dir.relative_to(self.base_dir)
        except ValueError as error:
            raise GitContextError("Encrypted output is outside the repository; refusing to stage it.") from error
        if not relative.parts:
            raise GitContextError("Encrypted output is the repository root; refusing to stage it.")
        return f":(literal){relative.as_posix()}"

    def encrypt_private_files(self):
        has_passphrase = self.passphrase_file.exists() or bool(os.environ.get("PRINT_DRIVE_PASSPHRASE"))
        if not self.encrypt_script.exists():
            raise SyncError(f"{ENCRYPT_SCRIPT_NAME} was not found.")
        if not has_passphrase:
            print(
                "Source files changed, but no local passphrase is configured. "
                f"Create {display_path(self.base_dir, self.passphrase_file)} or set PRINT_DRIVE_PASSPHRASE."
            )
            return False

        print("Source files are stable. Encrypting the incremental update...")
        result = self.run_command(["node", str(self.encrypt_script)])
        if result.stdout:
            print(result.stdout.strip())
        if result.stderr:
            print(result.stderr.strip())
        return True

    def validate_git_context(self):
        top_level = Path(self.run_git(["rev-parse", "--show-toplevel"]).stdout.strip()).resolve()
        if not same_filesystem_path(top_level, self.base_dir):
            raise GitContextError(
                f"Git top-level {top_level} does not match configured project root {self.base_dir}."
            )

        branch_result = self.run_git(["symbolic-ref", "--quiet", "--short", "HEAD"], check=False)
        if branch_result.returncode != 0:
            raise GitContextError("Git HEAD is detached; refusing to create an automatic commit.")
        branch = branch_result.stdout.strip()
        if branch != self.allowed_branch:
            raise GitContextError(
                f"Current branch {branch} is not the configured allowed branch {self.allowed_branch}; refusing to sync."
            )

        remote_result = self.run_git(["remote", "get-url", self.remote], check=False)
        if remote_result.returncode != 0:
            raise GitContextError(f"Configured Git remote {self.remote} does not exist.")

        upstream_result = self.run_git(
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
            check=False,
        )
        expected_upstream = f"{self.remote}/{self.allowed_branch}"
        actual_upstream = upstream_result.stdout.strip() if upstream_result.returncode == 0 else None
        if actual_upstream != expected_upstream:
            raise GitContextError(
                f"Branch upstream must be {expected_upstream}, found {actual_upstream or 'none'}. "
                f"Configure it with `git branch --set-upstream-to={expected_upstream} {self.allowed_branch}`."
            )
        self.git_pathspec()

    def prepare_remote_base(self):
        """Fast-forward a clean, behind-only checkout before any encryption work."""
        self.validate_git_context()
        fetch_result = self.run_git([
            "fetch",
            "--quiet",
            "--no-tags",
            self.remote,
            f"refs/heads/{self.allowed_branch}:refs/remotes/{self.remote}/{self.allowed_branch}",
        ], check=False)
        if fetch_result.returncode != 0:
            raise PushPendingError(
                "Could not refresh the remote branch before encryption. No encrypted files were changed. "
                f"Git detail: {sanitize_git_output(fetch_result.stderr)}"
            )
        dirty = self.run_git(["status", "--porcelain=v1"]).stdout.strip()
        if dirty:
            raise GitContextError(
                "The worktree is dirty; refusing to fast-forward or encrypt. Commit, stash, or discard the listed changes first."
            )
        ahead, behind = self.ahead_behind()
        if ahead > 0 and behind > 0:
            raise NonFastForwardError(
                "Local and remote branches have diverged. No merge, rebase, encryption, or force push was attempted."
            )
        if ahead > 0:
            raise NonFastForwardError(
                f"The local branch is {ahead} commit(s) ahead. Push or review those commits before auto-sync encrypts new files."
            )
        if behind > 0:
            result = self.run_git(["merge", "--ff-only", "@{upstream}"], check=False)
            if result.returncode != 0:
                raise NonFastForwardError(
                    "The remote-ahead checkout could not be fast-forwarded safely. No encryption was attempted. "
                    f"Git detail: {sanitize_git_output(result.stderr)}"
                )
            print(f"Fast-forwarded {behind} remote commit(s) before scanning the plaintext source.")

    def sync_to_github(self):
        self.validate_git_context()
        pathspec = self.git_pathspec()
        self.run_git(["add", "-A", "--", pathspec])
        status_result = self.run_git(["status", "--porcelain=v1", "--", pathspec])

        if status_result.stdout.strip():
            print("Encrypted output changes detected. Creating an output-scoped commit...")
            self.run_git([
                "commit",
                "--only",
                "-m",
                "Auto sync: encrypted files updated",
                "--",
                pathspec,
            ])
        else:
            print("No new encrypted output changes to commit; checking for a pending push.")

        fetch_result = self.run_git([
            "fetch",
            "--quiet",
            "--no-tags",
            self.remote,
            f"refs/heads/{self.allowed_branch}:refs/remotes/{self.remote}/{self.allowed_branch}",
        ], check=False)
        if fetch_result.returncode != 0:
            raise PushPendingError(
                "Could not refresh the remote branch. Any local output commit is preserved and will be retried. "
                f"Git detail: {sanitize_git_output(fetch_result.stderr)}"
            )

        ahead, behind = self.ahead_behind()
        if behind > 0:
            raise NonFastForwardError(
                f"Remote {self.remote}/{self.allowed_branch} is {behind} commit(s) ahead. "
                "No merge, rebase, or force push was attempted. Review `git status`, run `git pull --rebase` manually, "
                "resolve any conflict, then run the sync dry-run before restarting auto sync."
            )
        if ahead == 0:
            print("Encrypted output and remote branch are already synchronized.")
            return

        self.push_with_retry()
        print(f"Sync complete: pushed {ahead} pending commit(s) to {self.remote}/{self.allowed_branch}.")

    def ahead_behind(self):
        result = self.run_git(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
        try:
            ahead_text, behind_text = result.stdout.strip().split()
            return int(ahead_text), int(behind_text)
        except (ValueError, TypeError) as error:
            raise GitContextError("Could not determine local/remote commit counts.") from error

    def push_with_retry(self):
        last_error = None
        refspec = f"HEAD:refs/heads/{self.allowed_branch}"
        for attempt in range(1, self.push_retries + 2):
            result = self.run_git(["push", "--porcelain", self.remote, refspec], check=False)
            if result.returncode == 0:
                return
            last_error = sanitize_git_output(f"{result.stdout}\n{result.stderr}")
            lowered = last_error.lower()
            if "non-fast-forward" in lowered or "fetch first" in lowered or "rejected" in lowered:
                raise NonFastForwardError(
                    "Push was rejected because the remote changed after the safety fetch. "
                    "The local commit is preserved; no automatic merge or force push was attempted."
                )
            if any(marker in lowered for marker in PERMANENT_PUSH_MARKERS):
                break
            if attempt <= self.push_retries:
                print(f"Transient git push failure ({attempt}/{self.push_retries + 1}); retrying.")
                time.sleep(PUSH_RETRY_BASE_SECONDS * attempt)

        raise PushPendingError(
            "Push failed. The local output commit is preserved and a later sync pass will retry it. "
            f"Git detail: {last_error or 'unknown push error'}"
        )


def same_filesystem_path(first, second):
    normalize = lambda value: os.path.normcase(os.path.normpath(str(value)))
    return normalize(first) == normalize(second)


def validate_passphrase_path(project_root, source_directory, output_directory, passphrase_file):
    project_root = Path(project_root).resolve()
    source_directory = Path(source_directory).resolve()
    output_directory = Path(output_directory).resolve()
    passphrase_file = Path(passphrase_file).resolve()

    for directory in (source_directory, output_directory):
        try:
            passphrase_file.relative_to(directory)
            raise SyncError("The local passphrase file must not be inside source or encrypted output.")
        except ValueError:
            pass

    try:
        relative = passphrase_file.relative_to(project_root)
    except ValueError:
        return
    normalized = relative.as_posix()
    if normalized != DEFAULT_PASSPHRASE_FILE and not normalized.startswith(".tmp/"):
        raise SyncError("A custom passphrase file inside the repository is unsafe; keep it outside the repository.")


def process_is_running(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    if pid == os.getpid():
        return True
    if os.name == "nt":
        try:
            import ctypes

            process_query_limited_information = 0x1000
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
            kernel32.OpenProcess.restype = ctypes.c_void_p
            kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
            kernel32.CloseHandle.restype = ctypes.c_int
            handle = kernel32.OpenProcess(
                process_query_limited_information,
                False,
                pid,
            )
            if handle:
                kernel32.CloseHandle(handle)
                return True
            # Access denied still means a protected process with this PID exists.
            return ctypes.get_last_error() == 5
        except (AttributeError, OSError):
            return True
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError as error:
        return error.errno == errno.EPERM
    return True


def sanitize_git_output(value):
    text = (value or "").strip()
    text = re.sub(r"(https?://)[^/@\s]+@", r"\1[redacted]@", text, flags=re.IGNORECASE)
    text = re.sub(r"(?i)(token|password|passphrase|secret)=\S+", r"\1=[redacted]", text)
    return text[:1000] if text else "no additional detail"


def main():
    validate_dependencies()
    base_dir = get_project_root()
    try:
        config = load_runtime_config(base_dir)
    except SyncError as error:
        print(f"Configuration error: {error}")
        print("Run `node scripts/config_cli.mjs setup` and `node scripts/config_cli.mjs check`.")
        return 1

    if not config["autoSync"]:
        print("Auto sync is disabled by print-drive.config.json.")
        return 0

    public_dir = Path(config["encryptedOutputDirectory"]).resolve()
    private_dir = Path(config["sourceDirectory"]).resolve()
    passphrase_file = resolve_project_path(base_dir, "PRINT_DRIVE_PASSWORD_FILE", DEFAULT_PASSPHRASE_FILE)
    event_handler = SyncHandler(
        base_dir,
        private_dir,
        public_dir,
        passphrase_file,
        allowed_branch=config["allowedBranch"],
        remote=config["remote"],
    )
    observer = Observer()
    observer.schedule(event_handler, path=str(private_dir), recursive=True)

    print(f"Watching source directory {display_path(base_dir, private_dir)} recursively.")
    print(f"Encrypted output commits are restricted to {display_path(base_dir, public_dir)}.")
    observer.start()
    event_handler.request_initial_reconcile()
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping monitor...")
        event_handler.cancel_pending_sync()
        observer.stop()
    observer.join()
    return 0


if __name__ == "__main__":
    sys.exit(main())
