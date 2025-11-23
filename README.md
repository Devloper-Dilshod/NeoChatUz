# Real-time Random Video Chat

Simple random video chat using Node.js + Express + Socket.IO and WebRTC.

Features:
- No login required
- Start/Stop buttons for searching and ending calls
- Online user count
- WebRTC offer/answer and ICE candidate handling
- Responsive UI with Tailwind CSS

Run

1. Install dependencies:

```powershell
cd E:/Frontend/Edd_Academy/Projects/RealTime
npm install
```

2. Start the server (Python/Flask version):

```powershell
python -m pip install -r requirements.txt
python app.py
```

This project includes a Node version but the primary server is now a Flask app (`app.py`). The frontend remains in `public/` and the Flask server serves it.

3. Open http://localhost:3000 in two different browsers or devices and click `Start` to connect.

Notes
- This is a small demo using in-memory matching. For production, consider persistent data stores and authentication.

Ngrok auto-tunneling
--------------------

The server will attempt to start an ngrok tunnel automatically when the server starts. The public URL (HTTPS) will be printed to the console and returned by the `/info` endpoint so clients can connect through the tunnel.

Environment variables:
- `NGROK_AUTHTOKEN` (optional): your ngrok auth token to use your account's quota and reserved domains.
- `ENABLE_NGROK` (optional): set to `0` to disable automatic ngrok start.

Usage examples

Start server and auto-start ngrok (default behavior):

```powershell
npm start
```

Start server but do NOT start ngrok:

```powershell
$env:ENABLE_NGROK = '0'; npm start
```

Start ngrok with your auth token (optional):

```powershell
$env:NGROK_AUTHTOKEN = 'your_token_here'; npm start
```

Note: If you start the `ngrok` CLI manually, use a simple command like:

```powershell
ngrok http 3000
```

Do not pass the deprecated `--bind-tls` flag (for example `--bind-tls=true`) — newer ngrok versions will report `unknown flag: --bind-tls`.

How it works for testing with friends

- Run the server on your machine and let ngrok start. The console will show the public HTTPS URL (e.g. `https://abcd-1234.ngrok.io`).
- Share that HTTPS URL with a friend. When they open the URL in their browser, they will be served the app via the ngrok tunnel and automatically connect back for signaling.
- If you open the app on your local `http://localhost:3000`, the client will attempt to fetch `/info` and, if a ngrok URL is available, connect to that public URL for signaling so you can test across networks.

Notes and limitations
- This demo uses in-memory matching and does not persist sessions — restarting the server clears waiting users.
- For real-world usage, a TURN server is recommended for reliable media connectivity across restrictive NATs; ngrok only tunnels the signaling and HTTP assets.

Deploying to alwaysdata.com
--------------------------

alwaysdata supports Node.js apps. To prepare this app for deployment there:

1. Disable automatic ngrok start (it's only for local testing). Set the environment variable `ENABLE_NGROK=0` on alwaysdata.

2. Make sure `package.json` has a `start` script (it does):

```json
"scripts": { "start": "node server.js" }
```

3. Push the project to a git repo and connect it in alwaysdata (or upload files). In alwaysdata's dashboard, set the Node version and the start command to `npm start`.

4. Set environment variables on alwaysdata as needed (for production, set `ENABLE_NGROK=0` and `PORT` as provided by alwaysdata).

5. The server will run on the host/port provided by alwaysdata; ensure your `server.js` uses `process.env.PORT` (it does). Static files are served from `/public`.

Notes: TURN servers are still recommended in production for consistent media connectivity across restrictive networks. When deploying on alwaysdata, ensure you select a Python app, install requirements, and run `python app.py` as the start command (or use the WSGI runner with eventlet support).

