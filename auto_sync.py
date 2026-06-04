import os
import stat
import subprocess
import threading
import time
from pathlib import Path

from watchdog.events import FileSystemEventHandler
from watchdog.observers import Observer


DEBOUNCE_SECONDS = 2.5
PUSH_RETRIES = 2
PRIVATE_DIR_NAME = "private_files"
PUBLIC_DIR_NAME = "files"
PASSPHRASE_FILE_NAME = ".print-drive-passphrase"
ENCRYPT_SCRIPT_NAME = "encrypt_files.mjs"

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
    ".swp",
)
IGNORED_PREFIXES = (
    ".",
    "~$",
)


class SyncHandler(FileSystemEventHandler):
    def __init__(self, base_dir):
        self.base_dir = Path(base_dir)
        self.public_dir = self.base_dir / PUBLIC_DIR_NAME
        self.private_dir = self.base_dir / PRIVATE_DIR_NAME
        self.passphrase_file = self.base_dir / PASSPHRASE_FILE_NAME
        self.encrypt_script = self.base_dir / ENCRYPT_SCRIPT_NAME
        self.timer = None
        self.timer_lock = threading.Lock()
        self.sync_lock = threading.Lock()
        self.needs_encrypt = False

    def on_any_event(self, event):
        if event.is_directory:
            return

        path = Path(event.src_path)
        if self.should_ignore(path):
            return

        print(f"Detected event: {event.event_type} on {path}")
        try:
            resolved = path.resolve()
            if self.private_dir.resolve() in resolved.parents:
                self.needs_encrypt = True
        except OSError:
            pass

        self.schedule_sync()

    def should_ignore(self, path):
        name = path.name
        lower_name = name.lower()

        if name in IGNORED_NAMES:
            return True

        if any(name.startswith(prefix) for prefix in IGNORED_PREFIXES):
            return True

        if lower_name.endswith(IGNORED_SUFFIXES):
            return True

        try:
            attrs = os.stat(path).st_file_attributes
            if attrs & stat.FILE_ATTRIBUTE_HIDDEN:
                return True
        except (AttributeError, FileNotFoundError, OSError):
            pass

        return False

    def schedule_sync(self):
        with self.timer_lock:
            if self.timer is not None:
                self.timer.cancel()

            self.timer = threading.Timer(DEBOUNCE_SECONDS, self.run_scheduled_sync)
            self.timer.daemon = True
            self.timer.start()
            print(f"Sync scheduled in {DEBOUNCE_SECONDS:.1f}s.")

    def cancel_pending_sync(self):
        with self.timer_lock:
            if self.timer is not None:
                self.timer.cancel()
                self.timer = None

    def run_scheduled_sync(self):
        with self.timer_lock:
            self.timer = None

        if not self.sync_lock.acquire(blocking=False):
            print("Sync is already running. Scheduling one more pass.")
            self.schedule_sync()
            return

        try:
            if self.needs_encrypt:
                self.needs_encrypt = False
                self.encrypt_private_files()

            self.sync_to_github()
        finally:
            self.sync_lock.release()

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

    def encrypt_private_files(self):
        has_passphrase = self.passphrase_file.exists() or bool(os.environ.get("PRINT_DRIVE_PASSPHRASE"))
        if not self.encrypt_script.exists():
            print(f"{ENCRYPT_SCRIPT_NAME} was not found. Skipping encryption.")
            return

        if not has_passphrase:
            print(
                "Private files changed, but no local passphrase is configured. "
                f"Run `node {ENCRYPT_SCRIPT_NAME}` manually or create {PASSPHRASE_FILE_NAME}."
            )
            return

        print("Encrypting private files before sync...")
        result = self.run_command(["node", ENCRYPT_SCRIPT_NAME])
        if result.stdout:
            print(result.stdout.strip())
        if result.stderr:
            print(result.stderr.strip())

    def sync_to_github(self):
        try:
            self.run_git(["add", "files/"])
            status_result = self.run_git(["status", "--porcelain", "--", "files/"])

            if not status_result.stdout.strip():
                print("No encrypted file changes to commit.")
                return

            print("Encrypted changes detected. Committing and pushing...")
            self.run_git(["commit", "-m", "Auto sync: encrypted files updated"])
            self.push_with_retry()
            print("Sync complete.")
        except subprocess.CalledProcessError as error:
            print(f"Command failed: {' '.join(error.cmd)}")
            if error.stdout:
                print(f"stdout:\n{error.stdout.strip()}")
            if error.stderr:
                print(f"stderr:\n{error.stderr.strip()}")

            combined_output = f"{error.stdout}\n{error.stderr}".lower()
            if "fetch first" in combined_output or "non-fast-forward" in combined_output:
                print("Remote has newer commits. Run `git pull --rebase` manually, check the result, then push again.")
        except Exception as error:
            print(f"Unexpected sync error: {error}")

    def push_with_retry(self):
        last_error = None

        for attempt in range(1, PUSH_RETRIES + 2):
            try:
                self.run_git(["push"])
                return
            except subprocess.CalledProcessError as error:
                last_error = error
                print(f"git push failed (attempt {attempt}/{PUSH_RETRIES + 1}).")
                if error.stderr:
                    print(error.stderr.strip())

                if attempt <= PUSH_RETRIES:
                    time.sleep(2 * attempt)

        if last_error is not None:
            raise last_error


if __name__ == "__main__":
    base_dir = Path(__file__).resolve().parent
    public_dir = base_dir / PUBLIC_DIR_NAME
    private_dir = base_dir / PRIVATE_DIR_NAME
    public_dir.mkdir(exist_ok=True)
    private_dir.mkdir(exist_ok=True)

    event_handler = SyncHandler(base_dir)
    observer = Observer()
    observer.schedule(event_handler, path=str(public_dir), recursive=False)
    observer.schedule(event_handler, path=str(private_dir), recursive=False)

    print(f"Starting to monitor {private_dir} and {public_dir} for changes...")
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping monitor...")
        event_handler.cancel_pending_sync()
        observer.stop()

    observer.join()
