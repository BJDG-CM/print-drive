import os
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
except ImportError:
    print("Missing Python dependency: watchdog. Install it with `python -m pip install -r requirements.txt`.")
    sys.exit(1)


DEBOUNCE_SECONDS = 2.5
PUSH_RETRIES = 2
DEFAULT_PRIVATE_DIR = "private_files"
DEFAULT_PUBLIC_DIR = "files"
DEFAULT_PASSPHRASE_FILE = ".print-drive-passphrase"
ENCRYPT_SCRIPT_NAME = "encrypt_files.mjs"
SCRIPT_DIR = Path(__file__).resolve().parent

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


def get_project_root():
    value = os.environ.get("PRINT_DRIVE_ROOT")
    return Path(value).expanduser().resolve() if value else SCRIPT_DIR


def resolve_project_path(project_root, env_name, default_value):
    value = os.environ.get(env_name, default_value)
    path = Path(value).expanduser()
    return path.resolve() if path.is_absolute() else (project_root / path).resolve()


def display_path(project_root, path):
    try:
        return str(path.relative_to(project_root))
    except ValueError:
        return str(path)


def validate_dependencies():
    missing = []
    for command in ("node", "git"):
        if shutil.which(command) is None:
            missing.append(command)

    if missing:
        print(f"Missing required command(s): {', '.join(missing)}.")
        print("Install them and make sure they are available on PATH before running auto_sync.py.")
        sys.exit(1)


class SyncHandler(FileSystemEventHandler):
    def __init__(self, base_dir, private_dir, public_dir, passphrase_file):
        self.base_dir = Path(base_dir)
        self.public_dir = Path(public_dir)
        self.private_dir = Path(private_dir)
        self.passphrase_file = Path(passphrase_file)
        self.encrypt_script = SCRIPT_DIR / ENCRYPT_SCRIPT_NAME
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

    def git_path(self, path):
        try:
            return Path(path).resolve().relative_to(self.base_dir).as_posix()
        except ValueError:
            return str(path)

    def encrypt_private_files(self):
        has_passphrase = self.passphrase_file.exists() or bool(os.environ.get("PRINT_DRIVE_PASSPHRASE"))
        if not self.encrypt_script.exists():
            print(f"{ENCRYPT_SCRIPT_NAME} was not found. Skipping encryption.")
            return

        if not has_passphrase:
            print(
                "Private files changed, but no local passphrase is configured. "
                f"Run `node {ENCRYPT_SCRIPT_NAME}` manually or create {display_path(self.base_dir, self.passphrase_file)}."
            )
            return

        print("Encrypting private files before sync...")
        result = self.run_command(["node", str(self.encrypt_script)])
        if result.stdout:
            print(result.stdout.strip())
        if result.stderr:
            print(result.stderr.strip())

    def sync_to_github(self):
        try:
            public_git_path = self.git_path(self.public_dir)
            self.run_git(["add", public_git_path])
            status_result = self.run_git(["status", "--porcelain", "--", public_git_path])

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
    validate_dependencies()

    base_dir = get_project_root()
    public_dir = resolve_project_path(base_dir, "PRINT_DRIVE_OUTPUT_DIR", DEFAULT_PUBLIC_DIR)
    private_dir = resolve_project_path(base_dir, "PRINT_DRIVE_SOURCE_DIR", DEFAULT_PRIVATE_DIR)
    passphrase_file = resolve_project_path(base_dir, "PRINT_DRIVE_PASSWORD_FILE", DEFAULT_PASSPHRASE_FILE)
    public_dir.mkdir(parents=True, exist_ok=True)
    private_dir.mkdir(parents=True, exist_ok=True)

    event_handler = SyncHandler(base_dir, private_dir, public_dir, passphrase_file)
    observer = Observer()
    observer.schedule(event_handler, path=str(public_dir), recursive=False)
    observer.schedule(event_handler, path=str(private_dir), recursive=False)

    print(
        "Starting to monitor "
        f"{display_path(base_dir, private_dir)} and {display_path(base_dir, public_dir)} for changes..."
    )
    observer.start()

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping monitor...")
        event_handler.cancel_pending_sync()
        observer.stop()

    observer.join()
