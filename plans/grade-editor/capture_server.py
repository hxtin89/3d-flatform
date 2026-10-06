# Receives canvas captures from the viewer tab: POST http://127.0.0.1:5213/<name>.jpg with the
# image bytes. The hidden browser pane cannot screenshot the WebGPU canvas, so a capture is the
# canvas (or a texture image) drawn to an OffscreenCanvas in the page and posted here. Binding a
# port needs the sandbox off. Writes to $CAPTURE_DIR, or to <temp>/canopy-captures.
import os, re, tempfile
from http.server import BaseHTTPRequestHandler, HTTPServer

OUT = os.environ.get('CAPTURE_DIR') or os.path.join(tempfile.gettempdir(), 'canopy-captures')
os.makedirs(OUT, exist_ok=True)

class H(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', '*')
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def do_OPTIONS(self):
        self.send_response(204); self._cors(); self.end_headers()

    def do_POST(self):
        name = re.sub(r'[^A-Za-z0-9_.-]', '_', self.path.strip('/')) or 'capture.jpg'
        data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
        open(os.path.join(OUT, name), 'wb').write(data)
        self.send_response(200); self._cors(); self.end_headers(); self.wfile.write(b'ok')

    def log_message(self, *a): pass

HTTPServer(('127.0.0.1', 5213), H).serve_forever()
