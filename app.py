from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs
import os
import json
import requests
import sqlite3
import hashlib
import hmac
import logging
from dotenv import load_dotenv

load_dotenv()
logger = logging.getLogger("quickdm")
DB_PATH = os.environ.get("DB_PATH", os.path.join(os.path.dirname(__file__), "quickdm.db"))
MAX_BODY_BYTES = 1024 * 1024

def init_db():
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS processed_comments (
                comment_id TEXT PRIMARY KEY,
                dm_sent INTEGER DEFAULT 0,
                public_reply_sent INTEGER DEFAULT 0
            )
        """)

VERIFY_TOKEN = os.environ.get("VERIFY_TOKEN", "")
META_APP_SECRET = os.environ.get("META_APP_SECRET", "")
ACCESS_TOKEN = os.environ.get("INSTAGRAM_ACCESS_TOKEN", "")
IG_USER_ID = os.environ.get("IG_USER_ID", "17841423067800107")
API_VERSION = os.environ.get("API_VERSION", "v26.0")
REPLY_TEXT = (
    "Hey! 👋 Thanks for commenting ❤️\n\n"
    "Follow @uglyphase_ for more useful updates! 💯\n\n"
    "👇 Get your resources here:\n"
    "🔗 https://linktr.ee/uglyphase\n\n"
    "👇 Link not clickable? Tap the picture above (RahulPeddinti) to open the resources!\n\n"
    "Don't forget to follow for more! 🚀"
)
class QuickDMHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Default HTTP logging includes the verification token in the URL.
        logger.info("http_request method=%s", self.command)

    def do_GET(self):
        params = parse_qs(urlparse(self.path).query)
        if params.get("hub.mode") == ["subscribe"]:
            if VERIFY_TOKEN and params.get("hub.verify_token") == [VERIFY_TOKEN]:
                challenge = params.get("hub.challenge", [""])[0]
                if not challenge:
                    self.send_error(400, "Missing challenge")
                    return
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
            logger.info("private_reply_result status=%s", dm_response.status_code)

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
            logger.info("public_reply_result status=%s", comment_response.status_code)

            if comment_response.ok:
                with sqlite3.connect(DB_PATH) as conn:
                    conn.execute(
                        "UPDATE processed_comments SET public_reply_sent = 1 WHERE comment_id = ?",
                        (comment_id,)
                    )

        except requests.RequestException as error:
            logger.warning("reply_request_failed type=%s", type(error).__name__)

    def do_POST(self):
        if urlparse(self.path).path not in ("/", "/webhook"):
            self.send_error(404)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_error(400, "Invalid content length")
            return
        if not 0 < length <= MAX_BODY_BYTES:
            self.send_error(413 if length > MAX_BODY_BYTES else 400)
            return
        body = self.rfile.read(length)
        signature = self.headers.get("X-Hub-Signature-256", "")
        expected = "sha256=" + hmac.new(META_APP_SECRET.encode(), body, hashlib.sha256).hexdigest()
        if not META_APP_SECRET or not hmac.compare_digest(signature.encode("utf-8"), expected.encode("ascii")):
            self.send_error(403, "Invalid signature")
            return
        if not ACCESS_TOKEN:
            self.send_error(503, "Service not configured")
            return
        try:
            event = json.loads(body.decode("utf-8"))
            comments = parse_comments(event)
        except (ValueError, UnicodeDecodeError, TypeError):
            self.send_error(400, "Invalid event")
            return
        for comment_id in comments:
            self.send_private_reply(comment_id)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"EVENT_RECEIVED")


def parse_comments(event):
    """Validate the complete batch before executing any outbound action."""
    if not isinstance(event, dict) or not isinstance(event.get("entry", []), list):
        raise ValueError("Invalid event shape")
    if event.get("object") != "instagram":
        return []
    result = []
    for entry in event.get("entry", []):
        if not isinstance(entry, dict):
            raise ValueError("Invalid entry")
        if entry.get("id") != IG_USER_ID:
            continue
        changes = entry.get("changes", [])
        if not isinstance(changes, list):
            raise ValueError("Invalid changes")
        for change in changes:
            if not isinstance(change, dict):
                raise ValueError("Invalid change")
            if change.get("field") != "comments":
                continue
            value = change.get("value")
            if not isinstance(value, dict):
                raise ValueError("Invalid comment")
            author = value.get("from", {})
            if not isinstance(author, dict):
                raise ValueError("Invalid author")
            if author.get("id") == IG_USER_ID:
                continue
            comment_id = value.get("id")
            if not isinstance(comment_id, str) or not comment_id:
                raise ValueError("Invalid comment ID")
            result.append(comment_id)
    return result


def main():
    missing = [name for name, value in {
        "VERIFY_TOKEN": VERIFY_TOKEN,
        "INSTAGRAM_ACCESS_TOKEN": ACCESS_TOKEN,
        "META_APP_SECRET": META_APP_SECRET,
        "IG_USER_ID": IG_USER_ID,
    }.items() if not value]
    if missing:
        raise SystemExit("Missing required configuration: " + ", ".join(missing))
    logging.basicConfig(level=logging.INFO)
    init_db()
    server = HTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8001"))), QuickDMHandler)
    logger.info("quickdm_started")
    try:
        server.serve_forever()
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
