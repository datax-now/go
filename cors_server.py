#!/usr/bin/env python3
"""
HTTP server with CORS enabled and better error handling for JupyterLite
"""
import http.server
import json
import mimetypes
import os
import random
import socket
import socketserver
import sys
import tempfile
import time
import urllib.parse
from functools import partial
from datetime import datetime, timezone

class CORSRequestHandler(http.server.SimpleHTTPRequestHandler):
    # Increase timeout for large file transfers
    timeout = 300  # 5 minutes

    def _dist_root(self) -> str:
        return os.fspath(self.directory)

    def _send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _utc_iso(self, ts: float | None) -> str:
        # Jupyter contents API uses UTC timestamps with a trailing Z.
        if ts is None:
            dt = datetime.now(timezone.utc)
        else:
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)
        # Match the style seen in dist/api/contents/all.json (microseconds + Z).
        return dt.isoformat().replace('+00:00', 'Z')

    def _safe_join_under(self, root: str, rel: str) -> str | None:
        # Prevent path traversal outside the dist root.
        rel_norm = rel.replace('\\', '/')
        rel_norm = rel_norm.lstrip('/')
        candidate = os.path.normpath(os.path.join(root, rel_norm))
        root_norm = os.path.normpath(root)
        if not (candidate == root_norm or candidate.startswith(root_norm + os.sep)):
            return None
        return candidate

    def _contents_item_for_path(self, files_root: str, rel_path: str, fs_path: str) -> dict:
        name = os.path.basename(rel_path)
        is_dir = os.path.isdir(fs_path)
        mtime = None
        size = None
        try:
            st = os.stat(fs_path)
            mtime = st.st_mtime
            size = st.st_size
        except Exception:
            pass

        if is_dir:
            item_type = 'directory'
            mimetype = None
            size = 0
        else:
            if name.endswith('.ipynb'):
                item_type = 'notebook'
                mimetype = None
            else:
                item_type = 'file'
                mimetype, _enc = mimetypes.guess_type(name)

        return {
            'content': None,
            'created': self._utc_iso(mtime),
            'format': None,
            'hash': None,
            'hash_algorithm': None,
            'last_modified': self._utc_iso(mtime),
            'mimetype': mimetype,
            'name': name,
            'path': rel_path,
            'size': int(size) if size is not None else None,
            'type': item_type,
            'writable': True,
        }

    def _directory_model(self, rel_dir: str, content_items: list[dict]) -> dict:
        now = self._utc_iso(None)
        name = os.path.basename(rel_dir) if rel_dir else ''
        return {
            'name': name,
            'path': rel_dir,
            'type': 'directory',
            'writable': True,
            'created': now,
            'last_modified': now,
            'format': 'json',
            'mimetype': None,
            'content': content_items,
        }
    
    def end_headers(self):
        # Add CORS headers
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Resource-Policy', 'cross-origin')
        # Add cache control for development
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        # Keep connection alive for long transfers
        self.send_header('Connection', 'keep-alive')
        self.send_header('Keep-Alive', 'timeout=300, max=100')
        super().end_headers()
    
    def do_GET(self):
        # Handle manifest.webmanifest specially to avoid redirect issues
        if self.path.endswith('manifest.webmanifest'):
            try:
                # Serve a simple, static manifest
                manifest_content = '''{
  "name": "DataX.now",
  "short_name": "DataX.now",
  "description": "JupyterLite with DataX.now kernel",
  "start_url": ".",
  "display": "standalone",
  "theme_color": "#ffffff",
  "background_color": "#ffffff",
  "icons": []
}'''
                self.send_response(200)
                self.send_header('Content-Type', 'application/manifest+json')
                self.send_header('Content-Length', len(manifest_content))
                self.end_headers()
                self.wfile.write(manifest_content.encode())
                return
            except Exception as e:
                self.log_error('Error serving manifest: %s', str(e))
        
        # JupyterLite uses prebuilt indexes at /api/contents/**/all.json.
        # In dev mode we may not have per-directory all.json files, but returning
        # HTML 404s can break clients (JSON parse errors) and can even deadlock
        # DriveFS-style mounts waiting for a successful response.
        if self.path.startswith('/api/contents/'):

            path_only = self.path.split('?')[0].split('#')[0]

            # If a concrete file exists in dist/ (e.g. /api/contents/all.json),
            # let SimpleHTTPRequestHandler serve it.
            disk_rel = path_only.lstrip('/')
            disk_path = self._safe_join_under(self._dist_root(), disk_rel)
            if disk_path is not None and os.path.exists(disk_path):
                return super().do_GET()

            # Synthesize directory listings for any missing /api/contents/<dir>/all.json
            if path_only.endswith('/all.json'):
                # Extract the directory portion after /api/contents/
                encoded_dir = path_only[len('/api/contents/'): -len('/all.json')]
                encoded_dir = encoded_dir.strip('/')
                rel_dir = urllib.parse.unquote(encoded_dir)
                rel_dir = rel_dir.strip('/')

                files_root = os.path.join(self._dist_root(), 'files')
                fs_dir = self._safe_join_under(files_root, rel_dir)

                items: list[dict] = []
                if fs_dir is not None and os.path.isdir(fs_dir):
                    try:
                        for entry in sorted(os.listdir(fs_dir)):
                            entry_rel = f"{rel_dir}/{entry}".strip('/')
                            entry_fs = os.path.join(fs_dir, entry)
                            items.append(self._contents_item_for_path(files_root, entry_rel, entry_fs))
                    except Exception:
                        # Best-effort: if listing fails, still return an empty directory model.
                        items = []

                self._send_json(200, self._directory_model(rel_dir, items))
                return

            # Non-all.json contents endpoints: return JSON (never HTML) to avoid
            # "Unexpected token <" in clients.
            self._send_json(404, {"message": "Not Found", "reason": None})
            return
        
        # For all other requests, use default handler
        super().do_GET()
    
    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()
    
    def log_message(self, format, *args):
        # Only log successful requests and real errors (not broken pipes)
        message = format % args
        if 'BrokenPipeError' in message or 'ConnectionResetError' in message:
            return  # Suppress these - they're normal when client cancels
        super().log_message(format, *args)
    
    def handle_one_request(self):
        """Handle a single HTTP request with better error handling"""
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError, socket.error) as e:
            # Client disconnected - this is normal, don't log as error
            pass
        except Exception as e:
            # Real errors should still be logged
            self.log_error('Request handler error: %s', str(e))
    
    def finish(self):
        """Finish the request with better error handling"""
        try:
            if not self.wfile.closed:
                super().finish()
        except (BrokenPipeError, ConnectionResetError, socket.error):
            # Client disconnected - this is normal
            pass


class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    """Threaded server to handle multiple simultaneous requests"""
    allow_reuse_address = True
    daemon_threads = True  # Don't wait for threads to finish on shutdown


def _default_port_file_path() -> str:
    # A stable per-machine path that doesn't require scanning many ports.
    # The VS Code extension can read this file to learn the current port.
    return os.path.join(tempfile.gettempdir(), 'datax-xeus-port.json')


def _safe_write_json(path_: str, payload: dict) -> None:
    # Best-effort atomic write.
    dir_ = os.path.dirname(path_)
    if dir_:
        os.makedirs(dir_, exist_ok=True)
    tmp = f"{path_}.tmp"
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, indent=2, sort_keys=True)
        f.write('\n')
    os.replace(tmp, path_)


def _try_remove(path_: str) -> None:
    try:
        os.remove(path_)
    except Exception:
        pass

if __name__ == '__main__':
    import argparse
    
    # Parse command-line arguments
    parser = argparse.ArgumentParser(description='HTTP server with CORS for JupyterLite')
    parser.add_argument('-p', '--port', type=int, default=None,
                        help='Port number to use (default: random port between 49152-65535)')
    parser.add_argument('--port-file', type=str, default=None,
                        help='Write a JSON file with the chosen port/baseUrl for client auto-discovery (default: $TMPDIR/datax-xeus-port.json).')
    args = parser.parse_args()
    
    # Pick a random port each run to minimise cache collisions between restarts
    PORT_RANGE = (3142, 7000)
    MAX_PORT_TRIES = 20
    script_dir = os.path.dirname(os.path.abspath(__file__))
    dist_dir = os.path.join(script_dir, 'dist')
    serve_dir = dist_dir if os.path.isdir(dist_dir) else os.getcwd()

    port_file = args.port_file
    if port_file is None:
        port_file = _default_port_file_path()
    else:
        port_file = port_file.strip() or _default_port_file_path()
    # Make the port file path stable regardless of the server working directory.
    port_file = os.path.abspath(port_file)

    handler = partial(CORSRequestHandler, directory=serve_dir)

    httpd = None
    
    # If a specific port is requested, try to use it
    if args.port is not None:
        try:
            httpd = ThreadedTCPServer(("127.0.0.1", args.port), handler)
        except OSError as e:
            print(f"Failed to bind to port {args.port}: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Try to bind to a random high port, retrying a few times on collision
        for _ in range(MAX_PORT_TRIES):
            port_candidate = random.randint(*PORT_RANGE)
            try:
                httpd = ThreadedTCPServer(("127.0.0.1", port_candidate), handler)
                break
            except OSError:
                continue

        if httpd is None:
            print("Failed to bind to a random port after multiple attempts", file=sys.stderr)
            sys.exit(1)

    with httpd:
        actual_port = httpd.server_address[1]
        base_url = f"http://localhost:{actual_port}/"

        # Port-file handshake (best-effort). This enables clients (like the VS Code extension)
        # to discover the actual port without scanning port ranges.
        try:
            _safe_write_json(
                port_file,
                {
                    'schema': 1,
                    'port': actual_port,
                    'baseUrl': base_url,
                    'pid': os.getpid(),
                    'cwd': serve_dir,
                    'timestampMs': int(time.time() * 1000),
                },
            )
            print(f"Wrote port handshake file: {port_file}")
        except Exception as e:
            print(f"Warning: failed to write port file {port_file}: {e}", file=sys.stderr)

        print(f"Server running at {base_url}")
        print(f"Serving directory: {serve_dir}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server...")
            httpd.shutdown()
        finally:
            _try_remove(port_file)
