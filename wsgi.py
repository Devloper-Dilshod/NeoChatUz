"""
WSGI helper for running under Gunicorn on Alwaysdata.

Usage examples:
  gunicorn -k eventlet -w 1 app:app
  gunicorn -k eventlet -w 1 wsgi:application

This file exposes `application` for WSGI servers and keeps compatibility with direct `python app.py` runs.
"""
from app import app, socketio

# Standard WSGI application (for simple WSGI servers)
application = app

# If you need to run socketio explicitly, use eventlet worker in gunicorn:
#   gunicorn -k eventlet -w 1 app:app
