import os
import time
import subprocess
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class SyncHandler(FileSystemEventHandler):
    def __init__(self, base_dir):
        self.base_dir = base_dir

    def on_any_event(self, event):
        if event.is_directory:
            return
            
        filename = os.path.basename(event.src_path)
        if filename.startswith('.') or filename.endswith('.tmp'):
            return

        print(f"Detected event: {event.event_type} on {event.src_path}")
        self.sync_to_github()

    def sync_to_github(self):
        # Wait 1 second to debounce multiple rapid events
        time.sleep(1)
        
        try:
            # Change to the base directory where git repo is initialized
            os.chdir(self.base_dir)
            
            # git add files/
            subprocess.run(['git', 'add', 'files/'], check=True, capture_output=True)
            
            # git status --porcelain
            status_result = subprocess.run(['git', 'status', '--porcelain'], check=True, capture_output=True, text=True)
            
            # If there are changes, commit and push
            if status_result.stdout.strip():
                print("Changes detected. Committing and pushing...")
                subprocess.run(['git', 'commit', '-m', 'Auto sync: files updated'], check=True, capture_output=True)
                subprocess.run(['git', 'push'], check=True, capture_output=True)
                print("Sync complete.")
            else:
                print("No actual changes to commit.")
                
        except subprocess.CalledProcessError as e:
            print(f"Git command failed: {e}")
            if e.stderr:
                print(f"Error details: {e.stderr.decode('utf-8') if isinstance(e.stderr, bytes) else e.stderr}")
        except Exception as e:
            print(f"An unexpected error occurred: {e}")

if __name__ == "__main__":
    base_dir = os.path.dirname(os.path.abspath(__file__))
    files_dir = os.path.join(base_dir, 'files')
    
    # Ensure the files directory exists
    os.makedirs(files_dir, exist_ok=True)
    
    event_handler = SyncHandler(base_dir)
    observer = Observer()
    observer.schedule(event_handler, path=files_dir, recursive=False)
    
    print(f"Starting to monitor {files_dir} for changes...")
    observer.start()
    
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nStopping monitor...")
        observer.stop()
        
    observer.join()
