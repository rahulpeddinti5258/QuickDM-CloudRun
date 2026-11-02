from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import os
import json
import requests
import sqlite3
from dotenv import load_dotenv

load_dotenv()
DB_PATH = os.path.join(os.path.dirname(__file__), "quickdm.db")

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS processed_comments (
                comment_id TEXT PRIMARY KEY,
                dm_sent INTEGER DEFAULT 0,
                public_reply_sent INTEGER DEFAULT 0
            )
        """)

init_db()
VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN", "quickdm_verify_2026")
ACCESS_TOKEN = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "")
IG_USER_ID = "17841423067800107"
API_VERSION = "v26.0"
REPLY_TEXT = (
    "Hey! 👋 Thanks for commenting ❤️\n\n"
    "Follow @uglyphase_ for more useful updates! 💯\n\n"
    "👇 Get your resources here:\n"
    "🔗 https://linktr.ee/uglyphase\n\n"
    "👇 Link not clickable? Tap the picture above (RahulPeddinti) to open the resources!\n\n"
    "Don't forget to follow for more! 🚀"
)
class QuickDMHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        if params.get("hub.mode") == ["subscribe"]:
            if params.get("hub.verify_token") == [VERIFY_TOKEN]:
                challenge = params.get("hub.challenge", [""])[0]
                self.send_response(200)
                self.end_headers()
                self.wfile.write(challenge.encode())
                return
            self.send_error(403, "Invalid verify token")
            return

        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"QuickDM server is running!")


    
    def send_private_reply(self, comment_id):
        if not ACCESS_TOKEN or not comment_id:
            print("Missing access token or comment ID")
            return

        # Reserve this comment ID so duplicate webhooks are ignored.
        with sqlite3.connect(DB_PATH) as conn:
            cursor = conn.execute(
                "INSERT OR IGNORE INTO processed_comments (comment_id) VALUES (?)",
                (comment_id,)
            )
            if cursor.rowcount == 0:
                print("Duplicate comment ignored:", comment_id)
                return

        headers = {"Authorization": f"Bearer {ACCESS_TOKEN}"}
        dm_url = f"https://graph.instagram.com/{API_VERSION}/{IG_USER_ID}/messages"
        dm_payload = {
            "recipient": {"comment_id": comment_id},
            "message": {"text": REPLY_TEXT}
        }

        try:
            dm_response = requests.post(
                dm_url, json=dm_payload, headers=headers, timeout=20
            )
            print("Private reply status:", dm_response.status_code)
            print("Private reply response:", dm_response.text)

            if not dm_response.ok:
                print("DM failed; public reply skipped.")
                with sqlite3.connect(DB_PATH) as conn:
                    conn.execute(
                        "DELETE FROM processed_comments WHERE comment_id = ?",
                        (comment_id,)
                    )
                return

            with sqlite3.connect(DB_PATH) as conn:
                conn.execute(
                    "UPDATE processed_comments SET dm_sent = 1 WHERE comment_id = ?",
                    (comment_id,)
                )

            comment_url = f"https://graph.instagram.com/{API_VERSION}/{comment_id}/replies"
            comment_payload = {"message": "Check your DMs! 📩❤️"}

            comment_response = requests.post(
                comment_url, json=comment_payload,
                headers=headers, timeout=20
            )
            print("Public reply status:", comment_response.status_code)
            print("Public reply response:", comment_response.text)

            if comment_response.ok:
                with sqlite3.connect(DB_PATH) as conn:
                    conn.execute(
                        "UPDATE processed_comments SET public_reply_sent = 1 WHERE comment_id = ?",
                        (comment_id,)
                    )

        except requests.RequestException as error:
            print("Reply request failed:", error)

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length)

        try:
            event = json.loads(body.decode("utf-8"))
            print("Webhook event received:", json.dumps(event))
            for entry in event.get("entry", []):
                for change in entry.get("changes", []):
                    if change.get("field") == "comments":
                        value = change.get("value", {})
                        comment_id = value.get("id")
                        if comment_id:
                            print("Comment detected:", comment_id)
                            self.send_private_reply(comment_id)
        except (json.JSONDecodeError, UnicodeDecodeError):
            print("Received a non-JSON webhook payload")

        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"EVENT_RECEIVED")

server = HTTPServer(
    ("0.0.0.0", int(os.environ.get("PORT", "8001"))),
    QuickDMHandler
)
print("QuickDM server running")
server.serve_forever()
