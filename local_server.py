# server.py
import os
import logging
from flask import Flask, request, jsonify, send_from_directory
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import random
import time

# Logging sozlamalari
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__, static_folder='public')
app.config['SECRET_KEY'] = 'neochatuz-secret-key-2025'

# CORS
CORS(app, resources={r"/*": {"origins": "*"}})

# SocketIO
socketio = SocketIO(app, 
                   cors_allowed_origins="*",
                   logger=False,
                   engineio_logger=False)

# User management
users = {}
waiting_users = []
active_matches = {}

@socketio.on('connect')
def handle_connect():
    logger.info(f"✅ ULANDI: {request.sid}")
    users[request.sid] = {
        'id': request.sid,
        'name': 'Mehmon',
        'connected_at': time.time(),
        'media_ready': False
    }
    update_online_count()

@socketio.on('disconnect')
def handle_disconnect():
    logger.info(f"❌ CHIQDI: {request.sid}")
    
    if request.sid in waiting_users:
        waiting_users.remove(request.sid)
    
    for match_id, match in list(active_matches.items()):
        if request.sid in [match['user1'], match['user2']]:
            partner_id = match['user2'] if match['user1'] == request.sid else match['user1']
            if partner_id in users:
                emit('partner-disconnected', room=partner_id)
                # Sherikni kutish ro'yxatiga qo'shish
                if partner_id not in waiting_users:
                    waiting_users.append(partner_id)
                    emit('searching', room=partner_id)
            del active_matches[match_id]
    
    if request.sid in users:
        del users[request.sid]
    
    update_online_count()

@socketio.on('register')
def handle_register(data):
    name = data.get('name', 'Mehmon')[:20]
    users[request.sid]['name'] = name
    logger.info(f"📝 ISM: {request.sid} -> {name}")
    update_online_count()

@socketio.on('find')
def handle_find():
    logger.info(f"🔍 QIDIRMOQDA: {request.sid}")
    
    if request.sid not in waiting_users:
        waiting_users.append(request.sid)
    
    emit('searching')
    find_partner()

@socketio.on('stop-search')
def handle_stop_search():
    if request.sid in waiting_users:
        waiting_users.remove(request.sid)
    logger.info(f"⏹️ QIDIRISH TO'XTATDI: {request.sid}")
    update_online_count()

@socketio.on('media-ready')
def handle_media_ready(data):
    ready = data.get('ready', False)
    users[request.sid]['media_ready'] = ready
    update_online_count()

@socketio.on('offer')
def handle_offer(data):
    to_user = data.get('to')
    sdp = data.get('sdp')
    match_id = data.get('matchId')
    
    emit('offer', {
        'sdp': sdp,
        'from': request.sid,
        'matchId': match_id
    }, room=to_user)

@socketio.on('answer')
def handle_answer(data):
    to_user = data.get('to')
    sdp = data.get('sdp')
    match_id = data.get('matchId')
    
    emit('answer', {
        'sdp': sdp,
        'from': request.sid,
        'matchId': match_id
    }, room=to_user)

@socketio.on('ice-candidate')
def handle_ice_candidate(data):
    to_user = data.get('to')
    candidate = data.get('candidate')
    match_id = data.get('matchId')
    
    emit('ice-candidate', {
        'candidate': candidate,
        'from': request.sid,
        'matchId': match_id
    }, room=to_user)

@socketio.on('skip')
def handle_skip(data):
    to_user = data.get('to')
    match_id = data.get('matchId')
    
    logger.info(f"⏭️ SKIP: {request.sid}")
    
    if match_id in active_matches:
        match = active_matches[match_id]
        user1 = match['user1']
        user2 = match['user2']
        
        # Skip qilgan foydalanuvchini waiting ga qaytarish
        if request.sid not in waiting_users:
            waiting_users.append(request.sid)
            emit('searching', room=request.sid)
        
        # Sherigiga skip xabari yuborish
        partner_id = user2 if user1 == request.sid else user1
        if partner_id in users:
            emit('partner-skipped', room=partner_id)
            # Sherikni ham waiting ga qaytarish
            if partner_id not in waiting_users:
                waiting_users.append(partner_id)
                emit('searching', room=partner_id)
        
        del active_matches[match_id]
    
    # Darrov yangi sherik qidirish
    find_partner()

@socketio.on('stop-call')
def handle_stop_call(data):
    to_user = data.get('to')
    match_id = data.get('matchId')
    
    logger.info(f"⏹️ STOP: {request.sid}")
    
    if match_id in active_matches:
        match = active_matches[match_id]
        partner_id = match['user2'] if match['user1'] == request.sid else match['user1']
        
        # Faqat o'zini to'xtatish, sherikni qoldirish
        # Sherigiga stop xabari yuborish
        if partner_id in users:
            emit('partner-stopped', room=partner_id)
            # Sherikni kutish ro'yxatiga qo'shish
            if partner_id not in waiting_users:
                waiting_users.append(partner_id)
                emit('searching', room=partner_id)
        
        del active_matches[match_id]
    
    # O'zini kutish ro'yxatidan olib tashlash
    if request.sid in waiting_users:
        waiting_users.remove(request.sid)
    
    update_online_count()

def find_partner():
    """Sherik topish"""
    if len(waiting_users) < 2:
        return
    
    # Barcha kutayotgan foydalanuvchilarni aralashtirish
    random.shuffle(waiting_users)
    
    # Juftlar yaratish
    pairs = []
    for i in range(0, len(waiting_users) - 1, 2):
        user1 = waiting_users[i]
        user2 = waiting_users[i + 1]
        
        if user1 in users and user2 in users:
            pairs.append((user1, user2))
    
    # Har bir juft uchun match yaratish
    for user1, user2 in pairs:
        match_id = f"match_{int(time.time())}_{random.randint(1000,9999)}"
        
        active_matches[match_id] = {
            'user1': user1,
            'user2': user2,
            'user1_name': users[user1]['name'],
            'user2_name': users[user2]['name']
        }
        
        # User1 ga ma'lumot
        emit('found', {
            'partnerId': user2,
            'partnerName': users[user2]['name'],
            'matchId': match_id,
            'initiator': True
        }, room=user1)
        
        # User2 ga ma'lumot
        emit('found', {
            'partnerId': user1,
            'partnerName': users[user1]['name'],
            'matchId': match_id,
            'initiator': False
        }, room=user2)
        
        logger.info(f"🤝 ULANDI: {users[user1]['name']} va {users[user2]['name']}")
    
    # Waiting ro'yxatini yangilash
    for user1, user2 in pairs:
        if user1 in waiting_users:
            waiting_users.remove(user1)
        if user2 in waiting_users:
            waiting_users.remove(user2)

def update_online_count():
    """Online sonini yangilash"""
    count_data = {
        'total': len(users),
        'ready': len([u for u in users if users[u].get('media_ready', False)]),
        'waiting': len(waiting_users)
    }
    socketio.emit('online-count', count_data)

# Static fayllar
@app.route('/')
def serve_index():
    return send_from_directory(app.static_folder, 'index.html')

@app.route('/<path:path>')
def serve_static(path):
    return send_from_directory(app.static_folder, path)

if __name__ == '__main__':
    logger.info("🚀 NEOCHATUZ SERVER ISHGA TUSHMODA...")
    logger.info("📡 http://localhost:5000")
    socketio.run(app, 
                 host='0.0.0.0', 
                 port=5000, 
                 debug=False, 
                 allow_unsafe_werkzeug=True)