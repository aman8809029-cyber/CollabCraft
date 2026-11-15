"""Set a new password for a CollabCraft test account using Supabase Admin API.

Run this manually from the Backend folder. Never put the service key in frontend code.
"""

import os
from getpass import getpass

from dotenv import load_dotenv
from supabase import create_client


load_dotenv()

supabase_url = os.getenv("SUPABASE_URL")
service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

if not supabase_url or not service_role_key:
    raise SystemExit(
        "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in Backend/.env."
    )

user_id = input("Auth user UUID: ").strip()
if not user_id:
    raise SystemExit("A user UUID is required.")

new_password = getpass("New test password (input hidden): ")
confirm_password = getpass("Confirm new test password: ")

if len(new_password) < 8:
    raise SystemExit("Use a password with at least 8 characters.")
if new_password != confirm_password:
    raise SystemExit("Passwords do not match; no change was made.")

supabase = create_client(supabase_url, service_role_key)
supabase.auth.admin.update_user_by_id(
    user_id,
    {"password": new_password, "email_confirm": True},
)

print("Password updated. Sign in with that user's email and the new password.")
