import os
import subprocess
import shutil
import stat
import sys
import threading
import time
import unittest
import uuid
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
TEST_TMP_ROOT = ROOT / ".tmp" / "python-sync-tests"
sys.path.insert(0, str(ROOT))

import auto_sync  # noqa: E402


class SyntheticGitRepository:
    def __init__(self, root):
        self.root = Path(root)
        self.remote = self.root / "remote.git"
        self.work = self.root / "work"
        self.source = self.root / "source"
        self.output = self.work / "files"
        self.passphrase = self.root / "synthetic-passphrase"

        self.git(self.root, "init", "--bare", str(self.remote))
        self.work.mkdir()
        self.git(self.work, "init", "-b", "main")
        self.git(self.work, "config", "user.name", "Print Drive Test")
        self.git(self.work, "config", "user.email", "print-drive-test@example.invalid")
        self.output.mkdir()
        self.source.mkdir()
        (self.output / ".gitkeep").write_text("", encoding="utf-8")
        (self.work / "notes.txt").write_text("baseline\n", encoding="utf-8")
        self.git(self.work, "add", ".")
        self.git(self.work, "commit", "-m", "initial")
        self.git(self.work, "remote", "add", "origin", str(self.remote))
        self.git(self.work, "push", "-u", "origin", "main")

    @staticmethod
    def git(cwd, *args, check=True):
        result = subprocess.run(
            ["git", *args],
            cwd=cwd,
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if check and result.returncode != 0:
            raise AssertionError(
                f"git {' '.join(args)} failed ({result.returncode}): {result.stderr.strip() or result.stdout.strip()}"
            )
        return result

    def handler(self, handler_type=auto_sync.SyncHandler):
        return handler_type(
            self.work,
            self.source,
            self.output,
            self.passphrase,
            allowed_branch="main",
            remote="origin",
            debounce_seconds=0.01,
            push_retries=0,
        )


class AutoSyncGitTests(unittest.TestCase):
    def setUp(self):
        TEST_TMP_ROOT.mkdir(parents=True, exist_ok=True)
        self.temp_root = TEST_TMP_ROOT / f"print-drive-sync-test-{uuid.uuid4().hex}"
        self.temp_root.mkdir()
        self.repo = SyntheticGitRepository(self.temp_root)

    def tearDown(self):
        remove_test_tree(self.temp_root)
        try:
            TEST_TMP_ROOT.rmdir()
        except OSError:
            # Another parallel test process may still own a synthetic directory.
            pass

    def test_output_commit_preserves_unrelated_staged_files(self):
        notes = self.repo.work / "notes.txt"
        notes.write_text("user staged change\n", encoding="utf-8")
        self.repo.git(self.repo.work, "add", "notes.txt")
        (self.repo.output / "manifest.enc").write_text('{"version":2}\n', encoding="utf-8")

        self.repo.handler().sync_to_github()

        committed = self.repo.git(
            self.repo.work, "show", "--pretty=format:", "--name-only", "HEAD"
        ).stdout.splitlines()
        staged = self.repo.git(
            self.repo.work, "diff", "--cached", "--name-only"
        ).stdout.splitlines()
        self.assertEqual(committed, ["files/manifest.enc"])
        self.assertEqual(staged, ["notes.txt"])

    def test_commit_after_push_failure_is_retried_without_new_output_change(self):
        class FailOnceHandler(auto_sync.SyncHandler):
            failed_once = False

            def push_with_retry(self):
                if not self.failed_once:
                    self.failed_once = True
                    raise auto_sync.PushPendingError("synthetic push failure")
                return super().push_with_retry()

        (self.repo.output / "manifest.enc").write_text('{"version":2}\n', encoding="utf-8")
        handler = self.repo.handler(FailOnceHandler)
        with self.assertRaises(auto_sync.PushPendingError):
            handler.sync_to_github()

        ahead, behind = handler.ahead_behind()
        self.assertEqual((ahead, behind), (1, 0))
        handler.sync_to_github()
        self.assertEqual(handler.ahead_behind(), (0, 0))

    def test_non_fast_forward_is_preserved_for_manual_recovery(self):
        other = self.temp_root / "other"
        self.repo.git(self.temp_root, "clone", "-b", "main", str(self.repo.remote), str(other))
        self.repo.git(other, "config", "user.name", "Other Writer")
        self.repo.git(other, "config", "user.email", "other@example.invalid")
        (other / "remote-change.txt").write_text("remote\n", encoding="utf-8")
        self.repo.git(other, "add", "remote-change.txt")
        self.repo.git(other, "commit", "-m", "remote moves")
        self.repo.git(other, "push", "origin", "main")

        (self.repo.output / "manifest.enc").write_text('{"version":2}\n', encoding="utf-8")
        handler = self.repo.handler()
        with self.assertRaises(auto_sync.NonFastForwardError):
            handler.sync_to_github()
        self.assertEqual(handler.ahead_behind(), (1, 1))

    def test_branch_and_detached_head_guards_run_before_commit(self):
        handler = self.repo.handler()
        self.repo.git(self.repo.work, "switch", "-c", "feature")
        with self.assertRaises(auto_sync.GitContextError):
            handler.validate_git_context()

    def test_wrong_remote_is_rejected_before_commit(self):
        handler = self.repo.handler()
        handler.remote = "missing-remote"
        with self.assertRaises(auto_sync.GitContextError):
            handler.validate_git_context()
        self.repo.git(self.repo.work, "switch", "main")
        self.repo.git(self.repo.work, "checkout", "--detach", "HEAD")
        with self.assertRaises(auto_sync.GitContextError):
            handler.validate_git_context()

    def test_output_path_must_be_inside_repo_and_not_repo_root(self):
        outside = auto_sync.SyncHandler(
            self.repo.work,
            self.repo.source,
            self.temp_root / "outside",
            self.repo.passphrase,
        )
        with self.assertRaises(auto_sync.GitContextError):
            outside.git_pathspec()
        root_output = auto_sync.SyncHandler(
            self.repo.work,
            self.repo.source,
            self.repo.work,
            self.repo.passphrase,
        )
        with self.assertRaises(auto_sync.GitContextError):
            root_output.git_pathspec()

    def test_passphrase_path_must_not_overlap_data_or_use_custom_repo_file(self):
        with self.assertRaises(auto_sync.SyncError):
            auto_sync.SyncHandler(
                self.repo.work,
                self.repo.source,
                self.repo.output,
                self.repo.source / "password",
            )
        with self.assertRaises(auto_sync.SyncError):
            auto_sync.SyncHandler(
                self.repo.work,
                self.repo.source,
                self.repo.output,
                self.repo.work / "unsafe-password",
            )

    def test_repository_lock_blocks_a_concurrent_process(self):
        first = auto_sync.RepositorySyncLock(self.repo.work)
        second = auto_sync.RepositorySyncLock(self.repo.work)
        self.assertTrue(first.acquire())
        try:
            self.assertFalse(second.acquire())
        finally:
            first.release()
        self.assertTrue(second.acquire())
        second.release()

    def test_stale_lock_is_reclaimed_only_after_its_owner_exits(self):
        owner = auto_sync.RepositorySyncLock(self.repo.work, stale_seconds=1)
        contender = auto_sync.RepositorySyncLock(self.repo.work, stale_seconds=1)
        self.assertTrue(owner.acquire())
        old = time.time() - 60
        os.utime(owner.path, (old, old))
        self.assertFalse(contender.acquire(), "an old but live-owner lock must remain active")
        owner.release()

        contender.path.write_text(
            '{"pid": 2147483647, "createdAt": 0}',
            encoding="utf-8",
        )
        os.utime(contender.path, (old, old))
        self.assertTrue(contender.acquire(), "a stale lock with no live owner should be reclaimed")
        contender.release()

    def test_write_completion_waits_for_a_stable_snapshot(self):
        target = self.repo.source / "synthetic.txt"
        target.write_text("first", encoding="utf-8")
        handler = self.repo.handler()

        def finish_write():
            time.sleep(0.025)
            target.write_text("second and complete", encoding="utf-8")

        writer = threading.Thread(target=finish_write)
        writer.start()
        with mock.patch.object(auto_sync, "STABILITY_INTERVAL_SECONDS", 0.01), \
                mock.patch.object(auto_sync, "STABILITY_REQUIRED_SNAPSHOTS", 3), \
                mock.patch.object(auto_sync, "STABILITY_TIMEOUT_SECONDS", 1):
            snapshot = handler.wait_for_source_stability()
        writer.join()
        self.assertEqual(snapshot[0][1], len("second and complete"))

    def test_event_burst_debounces_and_concurrent_pass_reschedules(self):
        handler = self.repo.handler()
        timers = []

        class FakeTimer:
            def __init__(self, delay, callback):
                self.delay = delay
                self.callback = callback
                self.cancelled = False
                self.started = False
                self.daemon = False
                timers.append(self)

            def start(self):
                self.started = True

            def cancel(self):
                self.cancelled = True

        event = mock.Mock(
            is_directory=False,
            src_path=str(self.repo.source / "synthetic.txt"),
            event_type="modified",
        )
        with mock.patch.object(auto_sync.threading, "Timer", FakeTimer):
            handler.on_any_event(event)
            handler.on_any_event(event)
        self.assertEqual(handler.change_generation, 2)
        self.assertEqual(len(timers), 2)
        self.assertTrue(timers[0].cancelled)
        self.assertTrue(timers[1].started)

        handler.sync_lock.acquire()
        try:
            with mock.patch.object(handler, "schedule_sync") as schedule_sync:
                handler.run_scheduled_sync()
            schedule_sync.assert_called_once_with()
        finally:
            handler.sync_lock.release()

    def test_temp_hidden_and_symlink_names_are_not_encryption_triggers(self):
        handler = self.repo.handler()
        self.assertTrue(handler.should_ignore(self.repo.source / ".hidden"))
        self.assertTrue(handler.should_ignore(self.repo.source / "download.crdownload"))
        self.assertTrue(handler.should_ignore(self.repo.source / "~$office.docx"))

    def test_scheduled_sync_retries_a_preserved_pending_push(self):
        handler = self.repo.handler()
        with mock.patch.object(
            handler,
            "run_sync_pass",
            side_effect=auto_sync.PushPendingError("synthetic pending push"),
        ), mock.patch.object(handler, "schedule_sync") as schedule_sync:
            handler.run_scheduled_sync()

        schedule_sync.assert_called_once_with(delay=auto_sync.PUSH_PENDING_RETRY_SECONDS)


def remove_test_tree(target):
    if not target.exists():
        return

    last_error = None
    for attempt in range(5):
        def clear_readonly(function, file_path, _error):
            os.chmod(file_path, stat.S_IWRITE | stat.S_IREAD)
            function(file_path)

        try:
            shutil.rmtree(target, onexc=clear_readonly)
            return
        except OSError as error:
            last_error = error
            for directory, directories, files in os.walk(target, topdown=False):
                for name in files:
                    try:
                        os.chmod(Path(directory) / name, stat.S_IWRITE | stat.S_IREAD)
                    except OSError:
                        pass
                for name in directories:
                    try:
                        os.chmod(Path(directory) / name, stat.S_IWRITE | stat.S_IREAD)
                    except OSError:
                        pass
            time.sleep(0.2 * (attempt + 1))
    raise AssertionError(f"Could not clean synthetic sync repository {target}: {last_error}")


if __name__ == "__main__":
    unittest.main()
