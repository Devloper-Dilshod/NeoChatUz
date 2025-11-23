import os
import time
import random
from flask import Flask, send_from_directory, jsonify, request
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, 'public')

app = Flask(__name__, static_folder=PUBLIC_DIR, static_url_path='')
CORS(app)
# Use eventlet for better WebRTC signaling concurrency; install eventlet in requirements
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='eventlet')

# In-memory data
waiting_queue = []
peers = {}  # peers[sid] = partner_sid
match_of = {}  # match_of[sid] = match_id
usernames = {}  # usernames[sid] = name
media_ready = set()
connected = set()


def get_online_count():
    return len(socketio.server.manager.rooms.get('/', {}) ) if hasattr(socketio.server.manager, 'rooms') else len(socketio.server.environ)


def broadcast_online_count():
    # total should reflect actually connected sockets
    total = len(connected)
    ready = len(media_ready)
    sample = []
    for sid in list(media_ready)[:10]:
        sample.append({'id': sid, 'name': usernames.get(sid)})
    socketio.emit('online-count', {'total': total, 'ready': ready, 'sample': sample})


def remove_from_queue(sid):
    if sid in waiting_queue:
        waiting_queue.remove(sid)


def make_match_id(a, b):
    return f"{int(time.time())}-{random.randrange(1<<20):x}-{a[:6]}-{b[:6]}"


def cleanup_peer(sid, notify_partner=True):
    partner = peers.get(sid)
    if partner:
        peers.pop(partner, None)
        peers.pop(sid, None)
        match_of.pop(partner, None)
        match_of.pop(sid, None)
        if notify_partner:
            socketio.emit('partner-left', room=partner)


def try_match_all():
    # prune disconnected
    for sid in waiting_queue[:]:
        # check presence by username mapping or by inspecting session
        # we'll assume sockets that exist are present; no simple API, so keep as-is
        pass
    if len(waiting_queue) < 2:
        return
    # shuffle
    random.shuffle(waiting_queue)
    while len(waiting_queue) >= 2:
        a = waiting_queue.pop(0)
        b = waiting_queue.pop(0)
        if a is None or b is None:
            continue
        if a not in socketio.server.manager.rooms.get('/', {} ) and b not in socketio.server.manager.rooms.get('/', {} ):  # best-effort
            # still try
            pass
        # ensure not already peers
        if peers.get(a) or peers.get(b):
            if not peers.get(a) and a not in waiting_queue:
                waiting_queue.append(a)
            if not peers.get(b) and b not in waiting_queue:
                waiting_queue.append(b)
            continue
        match_id = make_match_id(a, b)
        peers[a] = b
        peers[b] = a
        match_of[a] = match_id
        match_of[b] = match_id
        initiator_for_a = random.random() < 0.5
        socketio.emit('found', {'partnerId': b, 'initiator': initiator_for_a, 'matchId': match_id, 'partnerName': usernames.get(b)}, room=a)
        socketio.emit('found', {'partnerId': a, 'initiator': not initiator_for_a, 'matchId': match_id, 'partnerName': usernames.get(a)}, room=b)
        print(f"Matched {a} <-> {b} ({match_id})")


@app.route('/')
def index():
    return send_from_directory(PUBLIC_DIR, 'index.html')


@app.route('/info')
def info():
    # For compatibility with previous client behavior, return no ngrokUrl
    return jsonify({'ngrokUrl': None, 'port': int(os.environ.get('PORT', 5000))})


@socketio.on('connect')
def on_connect():
    sid = request.sid
    print('connect', sid)
    # default username
    usernames[sid] = f'User-{sid[:5]}'
    connected.add(sid)
    broadcast_online_count()


@socketio.on('register')
def on_register(data):
    sid = request.sid
    name = str(data.get('name', '')).strip()[:32]
    if name:
        usernames[sid] = name
        emit('registered', {'name': name})
        broadcast_online_count()


@socketio.on('media-ready')
def on_media_ready(data):
    sid = request.sid
    ready = bool(data.get('ready'))
    if ready:
        media_ready.add(sid)
    else:
        media_ready.discard(sid)
    broadcast_online_count()


@socketio.on('find')
def on_find():
    sid = request.sid
    if peers.get(sid):
        return
    if sid not in waiting_queue:
        waiting_queue.append(sid)
    emit('searching')
    try_match_all()


@socketio.on('stop-search')
def on_stop_search():
    sid = request.sid
    remove_from_queue(sid)


@socketio.on('skip')
def on_skip(data=None):
    sid = request.sid
    partner = peers.get(sid)
    if partner:
        # notify partner
        socketio.emit('partner-left', room=partner)
        peers.pop(partner, None)
        match_of.pop(partner, None)
    peers.pop(sid, None)
    match_of.pop(sid, None)
    if sid not in waiting_queue:
        waiting_queue.append(sid)
    try_match_all()


@socketio.on('stop')
def on_stop():
    sid = request.sid
    cleanup_peer(sid, notify_partner=True)
    remove_from_queue(sid)


@socketio.on('offer')
def on_offer(data):
    sid = request.sid
    to = data.get('to')
    sdp = data.get('sdp')
    match_id = data.get('matchId')
    if not match_id or match_of.get(sid) != match_id or match_of.get(to) != match_id:
        return
    socketio.emit('offer', {'from': sid, 'sdp': sdp, 'matchId': match_id}, room=to)


@socketio.on('answer')
def on_answer(data):
    sid = request.sid
    to = data.get('to')
    sdp = data.get('sdp')
    match_id = data.get('matchId')
    if not match_id or match_of.get(sid) != match_id or match_of.get(to) != match_id:
        return
    socketio.emit('answer', {'from': sid, 'sdp': sdp, 'matchId': match_id}, room=to)


@socketio.on('ice-candidate')
def on_ice_candidate(data):
    sid = request.sid
    to = data.get('to')
    candidate = data.get('candidate')
    match_id = data.get('matchId')
    if not match_id or match_of.get(sid) != match_id or match_of.get(to) != match_id:
        return
    socketio.emit('ice-candidate', {'from': sid, 'candidate': candidate, 'matchId': match_id}, room=to)


@socketio.on('whoami')
def on_whoami():
    sid = request.sid
    emit('whoami', {'id': sid, 'name': usernames.get(sid)})


@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    print('disconnect', sid)
    remove_from_queue(sid)
    cleanup_peer(sid, notify_partner=True)
    usernames.pop(sid, None)
    media_ready.discard(sid)
    connected.discard(sid)
    broadcast_online_count()


if __name__ == '__main__':
    # Try to start server, but if port is in use try a few alternatives and print helpful messages.
    start_port = int(os.environ.get('PORT', 5000))
    max_tries = 10
    started = False
    for p in range(start_port, start_port + max_tries):
        try:
            print(f'Starting Flask-SocketIO server on port {p} (attempt)')
            socketio.run(app, host='0.0.0.0', port=p)
            started = True
            break
        except OSError as e:
            print(f'Port {p} unavailable: {e}')
            continue
        except Exception as e:
            print('Server failed to start:', e)
            raise
    if not started:
        print(f'Failed to bind server on ports {start_port}-{start_port+max_tries-1}.')
        print('Please stop any process using those ports or set environment variable PORT to an available port.')
