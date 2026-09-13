"""Real terminal CRUD smoke test. Requires Python's pyte package and a built CLI.

Run: bun run build && python scripts/verify-wizard-pty.py
Pass another command to verify an installed package, e.g. python scripts/verify-wizard-pty.py bunx @profullstack/r3q@0.1.4.
Only an ephemeral local HTTP server receives the final explicitly triggered request.
"""
import os, sys, pty, select, subprocess, termios, fcntl, struct, time, json, tempfile, pathlib, threading
from http.server import BaseHTTPRequestHandler, HTTPServer
try:
    import pyte
except ImportError:
    raise SystemExit('This optional terminal check requires pyte: python -m pip install pyte')

artifact = pathlib.Path(tempfile.mkdtemp(prefix='r3q-wizard-pty-'))
root = artifact / 'api'
root.mkdir()
hits = []
class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        hits.append(self.path)
        self.rfile.read(int(self.headers.get('content-length', '0')))
        body = b'{"ok":true}'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, *args): pass
server = HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 36, 120, 0, 0))
cmd = sys.argv[1:] or ['node', str(pathlib.Path(__file__).resolve().parents[1] / 'bin' / 'r3q.mjs')]
env = {**os.environ, 'TERM':'xterm-256color', 'COLORTERM':'truecolor', 'TOKEN':'pty-secret'}
proc = subprocess.Popen(cmd + [str(root)], stdin=slave, stdout=slave, stderr=slave, env=env, start_new_session=True)
os.close(slave)
screen = pyte.Screen(120,36)
stream = pyte.Stream(screen)
transcript = bytearray()
frames = {}

def pump(seconds=.2):
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        ready, _, _ = select.select([master], [], [], min(.05, max(0,end-time.monotonic())))
        if ready:
            try: chunk=os.read(master,65536)
            except OSError: break
            if not chunk: break
            transcript.extend(chunk)
            stream.feed(chunk.decode('utf-8',errors='replace'))

def text(): return '\n'.join(screen.display)
def expect(needle, timeout=6):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        pump(.1)
        if needle in text(): return
        if proc.poll() is not None: raise AssertionError(f'process exited {proc.returncode}: {text()}')
    raise AssertionError(f'missing {needle!r}:\n{text()}')

def send(value):
    os.write(master,value.encode())
    pump(.15)

def paste(value): send('\x1b[200~'+value+'\x1b[201~')
def frame(name): frames[name]=text()

try:
    expect('New request (n)')
    frame('empty')
    # Click the visible empty-state action, then cancel without a file.
    row=next(i for i,line in enumerate(screen.display) if 'New request (n)' in line)
    col=screen.display[row].index('New request (n)')+3
    send(f'\x1b[<0;{col+1};{row+1}M\x1b[<0;{col+1};{row+1}m')
    expect('1/3')
    send('\x1b')
    expect('New request (n)')
    assert list(root.iterdir())==[]
    # Enter also starts the empty-state wizard.
    send('\r')
    expect('1/3')
    frame('templates')
    send('\x1b[B\r')
    expect('2/3')
    expect('Content-Type: application/json')
    send('\x15PTY created')
    send('\t\t\x15')
    send(f'http://127.0.0.1:{server.server_port}/items')
    send('\t\x15')
    paste('Content-Type: application/json\nAuthorization: Bearer {{TOKEN}}')
    send('\t\x15')
    paste('{\n  "crud": "created",\n  "n": 1\n}')
    frame('details')
    send('\t\t\r')
    expect('3/3')
    frame('review')
    send('\r')
    expect('Saved pty-created.http')
    original=root/'pty-created.http'
    assert original.exists()
    assert 'Bearer {{TOKEN}}' in original.read_text()
    assert '"crud": "created"' in original.read_text()
    assert hits==[], 'saving must not send a request'
    send('v')
    expect('View pty-created.http')
    expect('Bearer {{TOKEN}}')
    frame('view')
    send('\x1b')
    send('e')
    expect('Edit request')
    send('\x15PTY edited')
    send('\t\t\t\t\x15')
    paste('{"crud":"updated"}')
    send('\x13')
    expect('Saved pty-created.http')
    assert 'PTY edited' in original.read_text() and '"updated"' in original.read_text()
    send('d')
    expect('Duplicate request')
    expect('pty-created-copy.http')
    send('\x13')
    expect('Saved pty-created-copy.http')
    copy=root/'pty-created-copy.http'
    assert copy.exists()
    copied=copy.read_text()
    send('x')
    expect('Delete request?')
    frame('delete')
    send('\r')
    assert copy.exists(), 'Enter defaults to Cancel'
    send('x')
    expect('Delete request?')
    send('\x1b[C\r')
    expect('Moved pty-created-copy.http')
    assert not copy.exists()
    assert any(p.read_text()==copied for p in (root/'.r3q-trash').iterdir())
    # Saving under an existing path leaves both the draft and file intact.
    saved=original.read_text()
    send('n\r')
    expect('2/3')
    send('\t\x15pty-created.http')
    send('\x13')
    expect('already exists')
    frame('overwrite')
    assert original.read_text()==saved
    send('\x1b')
    # Conflicting edits can become a copy without destroying external changes.
    send('e')
    expect('Edit request')
    original.write_text(saved+'external edit\n')
    send('\x13')
    expect('changed on disk')
    frame('conflict')
    send('\x04')
    expect('Duplicate request')
    send('\x13')
    expect('Saved pty-created-copy.http')
    assert original.read_text()==saved+'external edit\n'
    assert copy.exists()
    assert hits==[], 'CRUD must not send a request'
    # Explicit Enter on a saved request is the first network action.
    send('\r')
    expect('200 OK')
    assert hits==['/items']
    send('r')
    pump(.3)
    send('v')
    expect('View pty-created-copy.http')
    send('\x1b')
    send('q')
    proc.wait(timeout=5)
    assert proc.returncode==0
    print(json.dumps({'passed':True,'command':cmd,'artifact':str(artifact),'checks':['empty-state mouse New','empty-state Enter','method template','multiline headers/body','review','save/select','raw view','edit','duplicate/select','delete cancel','delete/trash','overwrite prevention','external conflict','save conflicting draft as copy','no automatic network','explicit send','reload preserves selection','quit'],'network_requests':hits},indent=2))
finally:
    (artifact/'frames.json').write_text(json.dumps(frames,indent=2))
    (artifact/'transcript.ansi').write_bytes(transcript)
    if proc.poll() is None: proc.kill(); proc.wait()
    os.close(master)
    server.shutdown()
