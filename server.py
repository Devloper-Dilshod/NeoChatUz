# server.py - AlwaysData uchun to'liq ishlaydigan versiya
import os
import logging
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import random
import time
import eventlet

# Eventlet dan foydalanish
eventlet.monkey_patch()

# Logging sozlamalari
logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder='.', static_url_path='')
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'neochatuz-secret-key-2025')

# CORS - barcha manbalarga ruxsat
CORS(app, resources={r"/*": {"origins": "*"}})

# SocketIO - AlwaysData uchun optimallashtirilgan
socketio = SocketIO(app,
                   cors_allowed_origins="*",
                   async_mode='eventlet',
                   logger=True,
                   engineio_logger=True,
                   ping_timeout=60,
                   ping_interval=25,
                   max_http_buffer_size=1e8)

# User management
users = {}
waiting_users = []
active_matches = {}

@socketio.on('connect')
def handle_connect():
    logger.info(f"✅ CLIENT CONNECTED: {request.sid}")
    users[request.sid] = {
        'id': request.sid,
        'name': 'Mehmon',
        'connected_at': time.time(),
        'media_ready': False
    }
    emit('connected', {'message': 'Serverga ulandingiz!', 'sid': request.sid})
    update_online_count()

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"❌ CLIENT DISCONNECTED: {request.sid}")
    
    # Waiting listdan olib tashlash
    if request.sid in waiting_users:
        waiting_users.remove(request.sid)
    
    # Active matcheslarni tozalash
    for match_id, match in list(active_matches.items()):
        if request.sid in [match['user1'], match['user2']]:
            partner_id = match['user2'] if match['user1'] == request.sid else match['user1']
            if partner_id in users:
                emit('partner-disconnected', room=partner_id)
                # Partnerni qayta qidiruvga qo'shish
                if partner_id not in waiting_users:
                    waiting_users.append(partner_id)
                    emit('searching', room=partner_id)
            # Matchni o'chirish
            del active_matches[match_id]
    
    # Userlarni tozalash
    if request.sid in users:
        del users[request.sid]
    
    update_online_count()

@socketio.on('register')
def handle_register(data):
    name = data.get('name', 'Mehmon')[:20]
    users[request.sid]['name'] = name
    logger.info(f"📝 REGISTER: {request.sid} -> {name}")
    emit('registered', {'status': 'success', 'name': name})
    update_online_count()

@socketio.on('find')
def handle_find():
    logger.info(f"🔍 FIND PARTNER: {request.sid} ({users[request.sid]['name']})")
    
    if request.sid not in waiting_users:
        waiting_users.append(request.sid)
    
    emit('searching', {'message': 'Sherik qidirilmoqda...'})
    find_partner()

@socketio.on('stop-search')
def handle_stop_search():
    if request.sid in waiting_users:
        waiting_users.remove(request.sid)
    logger.info(f"⏹️ STOP SEARCH: {request.sid}")
    update_online_count()

@socketio.on('media-ready')
def handle_media_ready(data):
    ready = data.get('ready', False)
    users[request.sid]['media_ready'] = ready
    logger.info(f"🎥 MEDIA READY: {request.sid} -> {ready}")
    update_online_count()

@socketio.on('offer')
def handle_offer(data):
    to_user = data.get('to')
    sdp = data.get('sdp')
    match_id = data.get('matchId')
    
    logger.info(f"📨 OFFER: {request.sid} -> {to_user}")
    if to_user in users:
        emit('offer', {
            'sdp': sdp,
            'from': request.sid,
            'matchId': match_id
        }, room=to_user)
    else:
        logger.warning(f"⚠️ OFFER: {to_user} topilmadi")

@socketio.on('answer')
def handle_answer(data):
    to_user = data.get('to')
    sdp = data.get('sdp')
    match_id = data.get('matchId')
    
    logger.info(f"📨 ANSWER: {request.sid} -> {to_user}")
    if to_user in users:
        emit('answer', {
            'sdp': sdp,
            'from': request.sid,
            'matchId': match_id
        }, room=to_user)
    else:
        logger.warning(f"⚠️ ANSWER: {to_user} topilmadi")

@socketio.on('ice-candidate')
def handle_ice_candidate(data):
    to_user = data.get('to')
    candidate = data.get('candidate')
    match_id = data.get('matchId')
    
    if to_user in users:
        emit('ice-candidate', {
            'candidate': candidate,
            'from': request.sid,
            'matchId': match_id
        }, room=to_user)
    else:
        logger.warning(f"⚠️ ICE-CANDIDATE: {to_user} topilmadi")

@socketio.on('skip')
def handle_skip(data):
    to_user = data.get('to')
    match_id = data.get('matchId')
    
    logger.info(f"⏭️ SKIP: {request.sid} -> {to_user}")
    
    if match_id in active_matches:
        match = active_matches[match_id]
        user1 = match['user1']
        user2 = match['user2']
        
        # Skip qilgan userni qayta qidiruvga qo'shish
        if request.sid not in waiting_users:
            waiting_users.append(request.sid)
            emit('searching', room=request.sid)
        
        # Partnerga xabar berish
        partner_id = user2 if user1 == request.sid else user1
        if partner_id in users:
            emit('partner-skipped', room=partner_id)
            if partner_id not in waiting_users:
                waiting_users.append(partner_id)
                emit('searching', room=partner_id)
        
        # Matchni o'chirish
        del active_matches[match_id]
    
    # Yangi sherik qidirish
    find_partner()

@socketio.on('stop-call')
def handle_stop_call(data):
    to_user = data.get('to')
    match_id = data.get('matchId')
    
    logger.info(f"⏹️ STOP CALL: {request.sid} -> {to_user}")
    
    if match_id in active_matches:
        match = active_matches[match_id]
        partner_id = match['user2'] if match['user1'] == request.sid else match['user1']
        
        # Partnerga xabar berish
        if partner_id in users:
            emit('partner-stopped', room=partner_id)
            if partner_id not in waiting_users:
                waiting_users.append(partner_id)
                emit('searching', room=partner_id)
        
        # Matchni o'chirish
        del active_matches[match_id]
    
    # Userni waiting listdan olib tashlash
    if request.sid in waiting_users:
        waiting_users.remove(request.sid)
    
    update_online_count()

def find_partner():
    """Sherik topish funksiyasi"""
    if len(waiting_users) < 2:
        logger.info(f"👥 WAITING USERS: {len(waiting_users)} - Sherik yetarli emas")
        return
    
    # Tasodifiy aralashtirish
    random.shuffle(waiting_users)
    
    pairs = []
    for i in range(0, len(waiting_users) - 1, 2):
        user1 = waiting_users[i]
        user2 = waiting_users[i + 1]
        
        if user1 in users and user2 in users:
            pairs.append((user1, user2))
    
    for user1, user2 in pairs:
        # Yangi match yaratish
        match_id = f"match_{int(time.time())}_{random.randint(1000,9999)}"
        
        active_matches[match_id] = {
            'user1': user1,
            'user2': user2,
            'user1_name': users[user1]['name'],
            'user2_name': users[user2]['name'],
            'created_at': time.time()
        }
        
        # User1 ga xabar
        emit('found', {
            'partnerId': user2,
            'partnerName': users[user2]['name'],
            'matchId': match_id,
            'initiator': True
        }, room=user1)
        
        # User2 ga xabar
        emit('found', {
            'partnerId': user1,
            'partnerName': users[user1]['name'],
            'matchId': match_id,
            'initiator': False
        }, room=user2)
        
        logger.info(f"🤝 MATCH CREATED: {users[user1]['name']} va {users[user2]['name']} -> {match_id}")
        
        # Waiting listdan olib tashlash
        if user1 in waiting_users:
            waiting_users.remove(user1)
        if user2 in waiting_users:
            waiting_users.remove(user2)
    
    update_online_count()

def update_online_count():
    """Online userlar sonini yangilash"""
    count_data = {
        'total': len(users),
        'ready': len([u for u in users if users[u].get('media_ready', False)]),
        'waiting': len(waiting_users),
        'active_matches': len(active_matches)
    }
    socketio.emit('online-count', count_data)
    logger.info(f"📊 ONLINE STATS: {count_data}")

# Routes
@app.route('/')
def serve_index():
    return send_from_directory('.', 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory('.', path)

@app.route('/health')
def health_check():
    return jsonify({
        'status': 'healthy',
        'service': 'NeoChatUz',
        'users_online': len(users),
        'waiting_users': len(waiting_users),
        'active_matches': len(active_matches),
        'timestamp': time.time()
    })

@app.route('/debug')
def debug_info():
    return jsonify({
        'users': {sid: users[sid] for sid in users},
        'waiting_users': waiting_users,
        'active_matches': active_matches
    })

@app.route('/status')
def status_page():
    return jsonify({
        'server': 'running',
        'socketio': 'enabled',
        'users_online': len(users),
        'uptime': time.time() - start_time
    })

# Server ishga tushgan vaqt
start_time = time.time()

# AlwaysData uchun WSGI application
application = app

if __name__ == '__main__':
    logger.info("🚀 NEOCHATUZ SERVER STARTING...")
    port = int(os.environ.get('PORT', 5000))
    socketio.run(app, 
                 host='0.0.0.0', 
                 port=port, 
                 debug=False, 
                 log_output=True,
                 use_reloader=False)