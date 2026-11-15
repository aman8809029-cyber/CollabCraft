import os
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlparse
from uuid import uuid4

from dotenv import load_dotenv
from flask import Flask, jsonify, request
from flask_cors import CORS
from supabase import create_client

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 11 * 1024 * 1024

frontend_origin = os.getenv("FRONTEND_ORIGIN", "http://localhost:5173")
CORS(app, resources={r"/api/*": {"origins": frontend_origin, "expose_headers": ["X-Has-More"]}})

supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_KEY")

supabase = (
    create_client(supabase_url, supabase_key)
    if supabase_url and supabase_key
    else None
)
service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY")
supabase_admin = (
    create_client(supabase_url, service_role_key)
    if supabase_url and service_role_key
    else None
)

_auth_user_cache = {}
_AUTH_USER_CACHE_SECONDS = 30
_AUTH_USER_CACHE_LIMIT = 500


def uppercase_content(value):
    """Normalize user-authored content to the app's uppercase writing style."""
    return str(value or "").strip().upper()


def normalize_github_repo_url(value):
    """Accept only a public GitHub repository root URL."""
    if value is None or value == "":
        return None
    if not isinstance(value, str) or len(value.strip()) > 500:
        raise ValueError("Enter a valid GitHub repository URL.")
    parsed = urlparse(value.strip())
    if parsed.scheme.lower() != "https" or parsed.hostname not in {"github.com", "www.github.com"}:
        raise ValueError("Use a public repository URL such as https://github.com/owner/repository.")
    parts = [part for part in parsed.path.strip("/").split("/") if part]
    if len(parts) != 2:
        raise ValueError("Link to the repository root, such as https://github.com/owner/repository.")
    owner, repository = parts
    if repository.lower().endswith(".git"):
        repository = repository[:-4]
    if not re.fullmatch(r"[A-Za-z0-9-]{1,39}", owner) or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", repository):
        raise ValueError("The GitHub owner or repository name is invalid.")
    return f"https://github.com/{owner}/{repository}"


def authenticated_user():
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token or supabase is None:
        return None
    return supabase.auth.get_user(token).user


def public_profile(user):
    """Return only the member profile fields intended to be public."""
    metadata = getattr(user, "user_metadata", None) or {}
    portfolio_url = str(metadata.get("portfolio_url") or "").strip()[:500]
    parsed_portfolio = urlparse(portfolio_url)
    if parsed_portfolio.scheme not in {"http", "https"} or not parsed_portfolio.netloc:
        portfolio_url = ""
    return {
        "display_name": str(metadata.get("display_name") or "").strip()[:80],
        "skills": str(metadata.get("skills") or "").strip()[:240],
        "bio": str(metadata.get("bio") or "").strip()[:500],
        "portfolio_url": portfolio_url,
    }


def auth_user_by_id(user_id):
    """Reuse recent Auth Admin lookups across related workspace requests."""
    key = str(user_id)
    now = time.monotonic()
    cached = _auth_user_cache.get(key)
    if cached and cached[0] > now:
        return cached[1]
    user = supabase_admin.auth.admin.get_user_by_id(key).user
    if len(_auth_user_cache) >= _AUTH_USER_CACHE_LIMIT:
        expired = [cache_key for cache_key, (expires_at, _) in _auth_user_cache.items() if expires_at <= now]
        for cache_key in expired:
            _auth_user_cache.pop(cache_key, None)
        while len(_auth_user_cache) >= _AUTH_USER_CACHE_LIMIT:
            _auth_user_cache.pop(next(iter(_auth_user_cache)))
    _auth_user_cache[key] = (now + _AUTH_USER_CACHE_SECONDS, user)
    return user


def project_access(project_id, user_id):
    """Return (project, role) for creator, member, or applicant; role is None otherwise."""
    project = (
        supabase_admin.table("projects")
        .select("id, owner_id")
        .eq("id", project_id)
        .maybe_single()
        .execute()
    ).data
    if not project:
        return None, None
    if str(project["owner_id"]) == str(user_id):
        return project, "creator"
    membership = (
        supabase_admin.table("project_members")
        .select("id")
        .eq("project_id", project_id)
        .eq("user_id", str(user_id))
        .limit(1)
        .execute()
    ).data
    if membership:
        return project, "member"
    application = (
        supabase_admin.table("applications")
        .select("id, status")
        .eq("project_id", project_id)
        .eq("applicant_id", str(user_id))
        .in_("status", ["pending", "accepted"])
        .limit(1)
        .execute()
    ).data
    if application:
        return project, "applicant"
    return project, None


def project_task_assignee_ids(project_id, owner_id):
    memberships = supabase_admin.table("project_members").select(
        "user_id"
    ).eq("project_id", project_id).execute().data
    return {str(owner_id), *(str(member["user_id"]) for member in memberships)}


@app.get("/")
def health_check():
    return jsonify(message="CollabCraft backend is running")


@app.get("/api/projects")
def list_projects():
    if supabase is None:
        return jsonify(error="Supabase settings are missing from Backend/.env"), 503

    status_filter = request.args.get("status", "open").strip().lower()
    if status_filter not in {"open", "closed", "completed", "all"}:
        return jsonify(error="Status must be open, closed, completed, or all."), 400
    pagination_requested = "page" in request.args or "per_page" in request.args
    page = 1
    per_page = 12
    if pagination_requested:
        try:
            page = int(request.args.get("page", "1"))
            per_page = int(request.args.get("per_page", "12"))
        except ValueError:
            return jsonify(error="Page and page size must be numbers."), 400
        if page < 1 or not 1 <= per_page <= 40:
            return jsonify(error="Page must be positive and page size must be between 1 and 40."), 400

    def execute_project_query(query):
        query = query.order("created_at", desc=True)
        if pagination_requested:
            start = (page - 1) * per_page
            return query.range(start, start + per_page).execute()
        return query.execute()

    try:
        try:
            query = supabase.table("projects").select(
                "id, title, description, tech_stack, github_url, created_at, "
                "status, is_active, project_roles(id, role_name, slots_total, slots_filled)"
            )
            if status_filter == "open":
                query = query.eq("is_active", True).eq("status", "open")
            elif status_filter != "all":
                query = query.eq("status", status_filter)
            result = execute_project_query(query)
        except Exception:
            app.logger.warning("Project status migration is not available yet; using legacy active-project query")
            if status_filter in {"closed", "completed"}:
                return jsonify([])
            query = supabase.table("projects").select(
                "id, title, description, tech_stack, created_at, "
                "project_roles(id, role_name, slots_total, slots_filled)"
            )
            if status_filter in {"open", "all"}:
                query = query.eq("is_active", True)
            result = execute_project_query(query)
            for project in result.data:
                project["status"] = "open"
                project["is_active"] = True
                project["github_url"] = None
        projects = result.data
        has_more = False
        if pagination_requested and len(projects) > per_page:
            projects = projects[:per_page]
            has_more = True
        response = jsonify(projects)
        response.headers["X-Has-More"] = "true" if has_more else "false"
        return response
    except Exception:
        app.logger.exception("Could not load projects from Supabase")
        return jsonify(error="Could not load projects"), 500


@app.get("/api/projects/<int:project_id>")
def get_project(project_id):
    if supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        viewer = None
        if token:
            viewer = supabase.auth.get_user(token).user
            if viewer is None:
                return jsonify(error="Your session is invalid. Please sign in again."), 401

        try:
            project = (
                supabase_admin.table("projects")
                .select("id, title, description, tech_stack, github_url, owner_id, status, is_active, created_at, project_roles(id, role_name, slots_total, slots_filled)")
                .eq("id", project_id)
                .maybe_single()
                .execute()
            ).data
        except Exception:
            app.logger.warning("Project status migration is not available; loading legacy project fields")
            project = (
                supabase_admin.table("projects")
                .select("id, title, description, tech_stack, owner_id, is_active, created_at, project_roles(id, role_name, slots_total, slots_filled)")
                .eq("id", project_id)
                .maybe_single()
                .execute()
            ).data
            if project:
                project["status"] = "open" if project.get("is_active") else "closed"
                project["github_url"] = None
        if not project:
            return jsonify(error="Project not found."), 404

        members = (
            supabase_admin.table("project_members")
            .select("id, user_id, role_id, joined_at")
            .eq("project_id", project_id)
            .order("joined_at")
            .execute()
        ).data
        participant_ids = {str(member["user_id"]) for member in members}
        owner_id = str(project["owner_id"])
        can_view_contacts = bool(viewer and (str(viewer.id) == owner_id or str(viewer.id) in participant_ids))
        access_role = None
        if viewer:
            viewer_id = str(viewer.id)
            if viewer_id == owner_id:
                access_role = "creator"
            elif viewer_id in participant_ids:
                access_role = "member"
            else:
                application = supabase_admin.table("applications").select("id").eq(
                    "project_id", project_id
                ).eq("applicant_id", viewer_id).in_("status", ["pending", "accepted"]).limit(1).execute().data
                if application:
                    access_role = "applicant"
        can_view_project_area = access_role is not None
        project.pop("owner_id", None)
        project["can_view_project_area"] = can_view_project_area
        project["can_manage_project"] = bool(viewer and str(viewer.id) == owner_id)
        creator = None
        if can_view_contacts:
            creator = auth_user_by_id(owner_id)
            if creator and creator.email:
                project["creator_email"] = creator.email
        roles_by_id = {str(role["id"]): role["role_name"] for role in project.get("project_roles", [])}
        project["members"] = []
        project["team_members"] = []
        team_member_ids = set()
        if access_role in {"creator", "member"} and creator:
            creator_profile = public_profile(creator)
            team_member_ids.add(str(creator.id))
            project["team_members"].append({
                "id": str(creator.id),
                "name": creator_profile["display_name"] or creator.email or "Project creator",
                "role_name": "Project creator",
            })
        for index, member in enumerate(members):
            member_data = {
                "id": member["id"],
                "label": f"Teammate {index + 1}",
                "role_name": roles_by_id.get(str(member["role_id"]), "Team member"),
                "joined_at": member["joined_at"],
            }
            member_user = auth_user_by_id(member["user_id"])
            if member_user:
                profile = public_profile(member_user)
                member_data.update(profile)
                if can_view_contacts and member_user.email:
                    member_data["email"] = member_user.email
                if access_role in {"creator", "member"} and str(member_user.id) not in team_member_ids:
                    team_member_ids.add(str(member_user.id))
                    project["team_members"].append({
                        "id": str(member_user.id),
                        "name": profile["display_name"] or member_user.email or "Team member",
                        "role_name": roles_by_id.get(str(member["role_id"]), "Team member"),
                    })
            project["members"].append(member_data)
        return jsonify(project)
    except Exception:
        app.logger.exception("Could not load project details")
        return jsonify(error="Could not load project details."), 500


@app.put("/api/projects/<int:project_id>/status")
def update_project_status(project_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to update this project."), 401
        payload = request.get_json(silent=True) or {}
        status = payload.get("status")
        if status not in {"open", "closed", "completed"}:
            return jsonify(error="Status must be open, closed, or completed."), 400
        project = supabase_admin.table("projects").select("id, owner_id").eq("id", project_id).maybe_single().execute().data
        if not project:
            return jsonify(error="Project not found."), 404
        if str(project["owner_id"]) != str(user.id):
            return jsonify(error="Only the project creator can change its status."), 403
        result = supabase_admin.table("projects").update({
            "status": status,
            "is_active": status == "open",
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("id", project_id).select("id, status, is_active").single().execute()
        return jsonify(result.data)
    except Exception:
        app.logger.exception("Could not update project status")
        return jsonify(error="Could not update project status. Apply the workspace database migration if needed."), 500


@app.put("/api/projects/<int:project_id>")
def update_project(project_id):
    """Update project details and roles. Only the project creator may edit."""
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to edit this project."), 401

        project = supabase_admin.table("projects").select(
            "id, owner_id"
        ).eq("id", project_id).maybe_single().execute().data
        if not project:
            return jsonify(error="Project not found."), 404
        if str(project["owner_id"]) != str(user.id):
            return jsonify(error="Only the project creator can edit its details."), 403

        payload = request.get_json(silent=True) or {}
        title = uppercase_content(payload.get("title", ""))
        description = uppercase_content(payload.get("description", ""))
        tech_stack = payload.get("tech_stack", [])
        roles = payload.get("roles", [])
        try:
            github_url = normalize_github_repo_url(payload.get("github_url")) if "github_url" in payload else None
        except ValueError as github_error:
            return jsonify(error=str(github_error)), 400
        if not title or not description:
            return jsonify(error="Project title and description are required."), 400
        if len(title) > 120 or len(description) > 2000:
            return jsonify(error="Title must be under 120 characters and description under 2,000."), 400
        if not isinstance(tech_stack, list) or not all(isinstance(item, str) for item in tech_stack):
            return jsonify(error="Tech stack must be a list of names."), 400
        if not isinstance(roles, list) or not roles or len(roles) > 20:
            return jsonify(error="Add between 1 and 20 team roles."), 400

        existing_roles = supabase_admin.table("project_roles").select(
            "id, role_name, slots_total, slots_filled"
        ).eq("project_id", project_id).execute().data
        existing_by_id = {str(role["id"]): role for role in existing_roles}
        clean_roles = []
        submitted_ids = set()
        for role in roles:
            if not isinstance(role, dict):
                return jsonify(error="Each role must include a name and openings."), 400
            role_name = uppercase_content(role.get("role_name", ""))
            try:
                slots_total = int(role.get("slots_total", 0))
            except (TypeError, ValueError):
                slots_total = 0
            role_id = role.get("id")
            existing = existing_by_id.get(str(role_id)) if role_id is not None else None
            if role_id is not None and (existing is None or str(role_id) in submitted_ids):
                return jsonify(error="A role is invalid or listed more than once. Refresh and try again."), 400
            if not role_name or len(role_name) > 80 or not 1 <= slots_total <= 20:
                return jsonify(error="Each role needs a name and 1–20 openings."), 400
            filled = int(existing.get("slots_filled", 0) or 0) if existing else 0
            if slots_total < filled:
                return jsonify(error=f"{role_name} already has {filled} team member(s); openings cannot be set below that."), 400
            if existing:
                submitted_ids.add(str(role_id))
            clean_roles.append({
                "id": role_id,
                "role_name": role_name,
                "slots_total": slots_total,
                "slots_filled": filled,
                "project_id": project_id,
            })

        removed_ids = [role["id"] for role in existing_roles if str(role["id"]) not in submitted_ids]
        if removed_ids:
            applications = supabase_admin.table("applications").select(
                "id"
            ).in_("role_id", removed_ids).limit(1).execute().data
            members = supabase_admin.table("project_members").select(
                "id"
            ).in_("role_id", removed_ids).limit(1).execute().data
            if applications or members:
                return jsonify(error="A role with application or team history can’t be removed. Keep it and set its openings to the number of current members."), 409

        project_updates = {
            "title": title,
            "description": description,
            "tech_stack": [item.strip().upper() for item in tech_stack if item.strip()],
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        if "github_url" in payload:
            project_updates["github_url"] = github_url
        supabase_admin.table("projects").update(project_updates).eq("id", project_id).execute()

        for role in clean_roles:
            role_data = {key: value for key, value in role.items() if key != "id"}
            if role["id"] is None:
                supabase_admin.table("project_roles").insert(role_data).execute()
            else:
                supabase_admin.table("project_roles").update({
                    "role_name": role["role_name"],
                    "slots_total": role["slots_total"],
                }).eq("id", role["id"]).eq("project_id", project_id).execute()
        if removed_ids:
            supabase_admin.table("project_roles").delete().in_("id", removed_ids).eq("project_id", project_id).execute()

        updated = supabase_admin.table("projects").select(
            "id, title, description, tech_stack, github_url, status, is_active, updated_at, project_roles(id, role_name, slots_total, slots_filled)"
        ).eq("id", project_id).single().execute().data
        return jsonify(updated)
    except Exception:
        app.logger.exception("Could not update project details")
        return jsonify(error="Could not update project details. Check the backend log and database schema."), 500


@app.get("/api/projects/<int:project_id>/workspace")
def get_project_workspace(project_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to view the project workspace."), 401
        project, access = project_access(project_id, user.id)
        if not project:
            return jsonify(error="Project not found."), 404
        if access is None:
            return jsonify(error="Apply to or join this project to view its workspace."), 403

        work_items = supabase_admin.table("project_work_items").select(
            "id, project_id, created_by, title, description, storage_path, file_name, mime_type, size_bytes, created_at, updated_at"
        ).eq("project_id", project_id).order("created_at", desc=True).execute().data
        file_paths = [item["storage_path"] for item in work_items if item.get("storage_path")]
        signed_urls_by_path = {}
        if file_paths:
            signed_items = supabase_admin.storage.from_("collabcraft-work").create_signed_urls(file_paths, 3600)
            signed_urls_by_path = {
                item.get("path"): item.get("signedURL") or item.get("signedUrl")
                for item in signed_items
                if not item.get("error") and item.get("path")
            }
        for item in work_items:
            item["file_url"] = signed_urls_by_path.get(item.get("storage_path"))

        feedback = supabase_admin.table("project_feedback").select(
            "id, author_id, kind, body, created_at"
        ).eq("project_id", project_id).order("created_at", desc=True).execute().data
        for entry in feedback:
            author = auth_user_by_id(entry["author_id"])
            entry["author_email"] = author.email if author and author.email else "Project participant"
        tasks = []
        task_board_available = access in {"creator", "member"}
        if task_board_available:
            try:
                tasks = supabase_admin.table("project_tasks").select(
                    "id, project_id, created_by, assigned_to, title, description, status, created_at, updated_at"
                ).eq("project_id", project_id).order("created_at", desc=True).execute().data
            except Exception:
                app.logger.warning("Project task table is not available; apply collabcraft_tasks_migration.sql")
                task_board_available = False
        return jsonify({
            "access": access,
            "work_items": work_items,
            "feedback": feedback,
            "tasks": tasks,
            "task_board_available": task_board_available,
        })
    except Exception:
        app.logger.exception("Could not load project workspace")
        return jsonify(error="Could not load project workspace. Apply the workspace database migration if needed."), 500


@app.post("/api/projects/<int:project_id>/tasks")
def create_project_task(project_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to add a project task."), 401
        project, access = project_access(project_id, user.id)
        if not project:
            return jsonify(error="Project not found."), 404
        if access not in {"creator", "member"}:
            return jsonify(error="Only project teammates can add tasks."), 403

        payload = request.get_json(silent=True) or {}
        title = uppercase_content(payload.get("title", ""))
        description = uppercase_content(payload.get("description", ""))
        assigned_to = str(payload.get("assigned_to") or "").strip() or None
        if not title or len(title) > 120 or len(description) > 1000:
            return jsonify(error="Enter a task title (up to 120 characters) and description (up to 1,000)."), 400
        if assigned_to and assigned_to not in project_task_assignee_ids(project_id, project["owner_id"]):
            return jsonify(error="Assign tasks only to this project's creator or current teammates."), 400

        result = supabase_admin.table("project_tasks").insert({
            "project_id": project_id,
            "created_by": str(user.id),
            "assigned_to": assigned_to,
            "title": title,
            "description": description,
            "status": "todo",
        }).select("id, project_id, created_by, assigned_to, title, description, status, created_at, updated_at").single().execute()
        return jsonify(result.data), 201
    except Exception:
        app.logger.exception("Could not create project task")
        return jsonify(error="Could not add this task. Make sure the task board database migration has been applied."), 500


@app.patch("/api/projects/<int:project_id>/tasks/<int:task_id>")
def update_project_task(project_id, task_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to update a project task."), 401
        project, access = project_access(project_id, user.id)
        if not project:
            return jsonify(error="Project not found."), 404
        if access not in {"creator", "member"}:
            return jsonify(error="Only project teammates can update tasks."), 403

        payload = request.get_json(silent=True) or {}
        updates = {"updated_at": datetime.now(timezone.utc).isoformat()}
        if "status" in payload:
            status = payload.get("status")
            if status not in {"todo", "in_progress", "done"}:
                return jsonify(error="Choose To do, In progress, or Done."), 400
            updates["status"] = status
        if "assigned_to" in payload:
            assigned_to = str(payload.get("assigned_to") or "").strip() or None
            if assigned_to and assigned_to not in project_task_assignee_ids(project_id, project["owner_id"]):
                return jsonify(error="Assign tasks only to this project's creator or current teammates."), 400
            updates["assigned_to"] = assigned_to
        if len(updates) == 1:
            return jsonify(error="Choose a task status or assignee to update."), 400

        result = supabase_admin.table("project_tasks").update(updates).eq(
            "project_id", project_id
        ).eq("id", task_id).select(
            "id, project_id, created_by, assigned_to, title, description, status, created_at, updated_at"
        ).maybe_single().execute()
        if not result.data:
            return jsonify(error="Task not found."), 404
        return jsonify(result.data)
    except Exception:
        app.logger.exception("Could not update project task")
        return jsonify(error="Could not update this task. Make sure the task board database migration has been applied."), 500


@app.get("/api/projects/<int:project_id>/chat")
def list_project_chat(project_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to view team chat."), 401
        project, access = project_access(project_id, user.id)
        if not project:
            return jsonify(error="Project not found."), 404
        if access not in {"creator", "member"}:
            return jsonify(error="Team chat is available only to the project creator and accepted teammates."), 403

        after_id_value = request.args.get("after_id")
        after_id = None
        if after_id_value is not None:
            try:
                after_id = int(after_id_value)
            except ValueError:
                return jsonify(error="The chat cursor is invalid."), 400
            if after_id < 0:
                return jsonify(error="The chat cursor is invalid."), 400

        try:
            query = supabase_admin.table("project_chat_messages").select(
                "id, project_id, author_id, body, created_at"
            ).eq("project_id", project_id)
            if after_id is None:
                messages = query.order("created_at", desc=True).limit(100).execute().data
                messages = list(reversed(messages))
            else:
                messages = query.gt("id", after_id).order("id").limit(100).execute().data
        except Exception:
            app.logger.warning("Project chat table is not available; apply collabcraft_chat_migration.sql")
            return jsonify(error="Team chat needs its database setup. Run Backend/collabcraft_chat_migration.sql in Supabase."), 503

        authors = {}
        for message in messages:
            author_id = str(message["author_id"])
            if author_id not in authors:
                author = auth_user_by_id(author_id)
                profile = public_profile(author) if author else {}
                authors[author_id] = profile.get("display_name") or (author.email if author and author.email else "Team member")
            message["author_name"] = authors[author_id]
        cursor = max((int(message["id"]) for message in messages), default=after_id or 0)
        return jsonify({"messages": messages, "cursor": cursor})
    except Exception:
        app.logger.exception("Could not load project chat")
        return jsonify(error="Could not load team chat."), 500


@app.post("/api/projects/<int:project_id>/chat")
def create_project_chat_message(project_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to send a team message."), 401
        project, access = project_access(project_id, user.id)
        if not project:
            return jsonify(error="Project not found."), 404
        if access not in {"creator", "member"}:
            return jsonify(error="Team chat is available only to the project creator and accepted teammates."), 403

        payload = request.get_json(silent=True) or {}
        body = uppercase_content(payload.get("body", ""))
        if not body or len(body) > 2000:
            return jsonify(error="Write a message between 1 and 2,000 characters."), 400
        try:
            result = supabase_admin.table("project_chat_messages").insert({
                "project_id": project_id,
                "author_id": str(user.id),
                "body": body,
            }).select("id, project_id, author_id, body, created_at").single().execute()
        except Exception:
            app.logger.warning("Project chat table is not available; apply collabcraft_chat_migration.sql")
            return jsonify(error="Team chat needs its database setup. Run Backend/collabcraft_chat_migration.sql in Supabase."), 503
        message = result.data
        profile = public_profile(user)
        message["author_name"] = profile["display_name"] or user.email or "Team member"
        return jsonify(message), 201
    except Exception:
        app.logger.exception("Could not send project chat message")
        return jsonify(error="Could not send this message."), 500


@app.post("/api/projects/<int:project_id>/work-items")
def create_project_work_item(project_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to add project work."), 401
        project, access = project_access(project_id, user.id)
        if not project:
            return jsonify(error="Project not found."), 404
        if access != "creator":
            return jsonify(error="Only the project creator can upload project work."), 403

        title = uppercase_content(request.form.get("title", ""))
        description = uppercase_content(request.form.get("description", ""))
        upload = request.files.get("file")
        if not title or len(title) > 120 or len(description) > 2000:
            return jsonify(error="Enter a title (up to 120 characters) and description (up to 2,000)."), 400
        storage_path = None
        file_name = None
        mime_type = None
        size_bytes = None
        if upload and upload.filename:
            raw_file = upload.read()
            if len(raw_file) > 10 * 1024 * 1024:
                return jsonify(error="Files must be 10 MB or smaller."), 400
            file_name = os.path.basename(upload.filename).replace("\\", "_")[:240]
            mime_type = upload.mimetype or "application/octet-stream"
            size_bytes = len(raw_file)
            storage_path = f"{project_id}/{user.id}/{uuid4().hex}-{file_name}"
            supabase_admin.storage.from_("collabcraft-work").upload(
                storage_path, raw_file, {"content-type": mime_type, "upsert": "false"}
            )
        try:
            result = supabase_admin.table("project_work_items").insert({
                "project_id": project_id,
                "created_by": str(user.id),
                "title": title,
                "description": description,
                "storage_path": storage_path,
                "file_name": file_name,
                "mime_type": mime_type,
                "size_bytes": size_bytes,
            }).execute()
        except Exception:
            if storage_path:
                supabase_admin.storage.from_("collabcraft-work").remove([storage_path])
            raise
        return jsonify(result.data[0]), 201
    except Exception:
        app.logger.exception("Could not create project work item")
        return jsonify(error="Could not upload project work. Apply the workspace migration and check that the private storage bucket exists."), 500


@app.put("/api/projects/<int:project_id>/work-items/<int:item_id>")
def update_project_work_item(project_id, item_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to edit project work."), 401
        project, access = project_access(project_id, user.id)
        if not project:
            return jsonify(error="Project not found."), 404
        if access != "creator":
            return jsonify(error="Only the project creator can edit project work."), 403
        payload = request.get_json(silent=True) or {}
        title = uppercase_content(payload.get("title", ""))
        description = uppercase_content(payload.get("description", ""))
        if not title or len(title) > 120 or len(description) > 2000:
            return jsonify(error="Enter a title (up to 120 characters) and description (up to 2,000)."), 400
        result = supabase_admin.table("project_work_items").update({
            "title": title,
            "description": description,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }).eq("project_id", project_id).eq("id", item_id).select("id, title, description, updated_at").maybe_single().execute()
        if not result.data:
            return jsonify(error="Work item not found."), 404
        return jsonify(result.data)
    except Exception:
        app.logger.exception("Could not update project work item")
        return jsonify(error="Could not update this work item."), 500


@app.post("/api/projects/<int:project_id>/feedback")
def create_project_feedback(project_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    try:
        user = authenticated_user()
        if user is None:
            return jsonify(error="Sign in to leave project feedback."), 401
        project, access = project_access(project_id, user.id)
        if not project:
            return jsonify(error="Project not found."), 404
        if access is None:
            return jsonify(error="Apply to or join this project before commenting."), 403
        payload = request.get_json(silent=True) or {}
        kind = payload.get("kind")
        body = uppercase_content(payload.get("body", ""))
        if kind not in {"comment", "suggestion"}:
            return jsonify(error="Choose comment or suggestion."), 400
        if not body or len(body) > 2000:
            return jsonify(error="Write between 1 and 2,000 characters."), 400
        result = supabase_admin.table("project_feedback").insert({
            "project_id": project_id,
            "author_id": str(user.id),
            "kind": kind,
            "body": body,
        }).execute()
        entry = result.data[0]
        entry["author_email"] = user.email or "Project participant"
        return jsonify(entry), 201
    except Exception:
        app.logger.exception("Could not create project feedback")
        return jsonify(error="Could not add feedback. Apply the workspace database migration if needed."), 500


@app.post("/api/projects")
def create_project():
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503

    authorization = request.headers.get("Authorization", "")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        return jsonify(error="Sign in before publishing a project."), 401

    created_project = None
    try:
        user_result = supabase.auth.get_user(token)
        user = user_result.user
        if user is None:
            return jsonify(error="Your session is invalid. Please sign in again."), 401

        payload = request.get_json(silent=True) or {}
        title = uppercase_content(payload.get("title", ""))
        description = uppercase_content(payload.get("description", ""))
        tech_stack = payload.get("tech_stack", [])
        roles = payload.get("roles", [])
        try:
            github_url = normalize_github_repo_url(payload.get("github_url"))
        except ValueError as github_error:
            return jsonify(error=str(github_error)), 400

        if not title or not description:
            return jsonify(error="Project title and description are required."), 400
        if len(title) > 120 or len(description) > 2000:
            return jsonify(error="Title must be under 120 characters and description under 2,000."), 400
        if not isinstance(tech_stack, list) or not all(isinstance(item, str) for item in tech_stack):
            return jsonify(error="Tech stack must be a list of names."), 400
        if not isinstance(roles, list) or not roles:
            return jsonify(error="Add at least one team role."), 400

        clean_roles = []
        for role in roles:
            if not isinstance(role, dict):
                return jsonify(error="Each role must include a name and openings."), 400
            role_name = uppercase_content(role.get("role_name", ""))
            try:
                slots_total = int(role.get("slots_total", 0))
            except (TypeError, ValueError):
                slots_total = 0
            if not role_name or len(role_name) > 80 or not 1 <= slots_total <= 20:
                return jsonify(error="Each role needs a name and 1–20 openings."), 400
            clean_roles.append({"role_name": role_name, "slots_total": slots_total, "slots_filled": 0})

        project_result = supabase_admin.table("projects").insert({
            "title": title,
            "description": description,
            "tech_stack": [item.strip().upper() for item in tech_stack if item.strip()],
            "github_url": github_url,
            "owner_id": str(user.id),
            "status": "open",
            "is_active": True,
        }).execute()
        project = project_result.data[0]
        created_project = project
        for role in clean_roles:
            role["project_id"] = project["id"]
        supabase_admin.table("project_roles").insert(clean_roles).execute()
        return jsonify(project), 201
    except Exception:
        app.logger.exception("Could not create project")
        if created_project is not None:
            try:
                supabase_admin.table("projects").delete().eq("id", created_project["id"]).execute()
            except Exception:
                app.logger.exception("Could not clean up a project after role insertion failed")
        return jsonify(error="Could not publish the project. Check the backend log and database schema."), 500


@app.post("/api/applications")
def create_application():
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503

    authorization = request.headers.get("Authorization", "")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        return jsonify(error="Sign in before applying."), 401

    try:
        user_result = supabase.auth.get_user(token)
        user = user_result.user
        if user is None:
            return jsonify(error="Your session is invalid. Please sign in again."), 401

        payload = request.get_json(silent=True) or {}
        project_id = payload.get("project_id")
        role_id = payload.get("role_id")
        pitch_message = uppercase_content(payload.get("pitch_message", ""))
        if not project_id or not role_id:
            return jsonify(error="Choose a project role before applying."), 400
        if len(pitch_message) < 10 or len(pitch_message) > 2000:
            return jsonify(error="Write an application note between 10 and 2,000 characters."), 400

        project_result = (
            supabase_admin.table("projects")
            .select("id, owner_id, is_active")
            .eq("id", project_id)
            .maybe_single()
            .execute()
        )
        project = project_result.data
        if not project or project.get("status", "open") != "open" or not project["is_active"]:
            return jsonify(error="This project is no longer open."), 404
        if str(project["owner_id"]) == str(user.id):
            return jsonify(error="You can’t apply to your own project."), 400

        role_result = (
            supabase_admin.table("project_roles")
            .select("id, project_id, role_name, slots_total, slots_filled")
            .eq("id", role_id)
            .eq("project_id", project_id)
            .maybe_single()
            .execute()
        )
        role = role_result.data
        if not role:
            return jsonify(error="That role does not belong to this project."), 404
        if int(role["slots_filled"] or 0) >= int(role["slots_total"] or 0):
            return jsonify(error="That role has no openings left."), 409

        existing = (
            supabase_admin.table("applications")
            .select("id")
            .eq("role_id", role_id)
            .eq("applicant_id", str(user.id))
            .limit(1)
            .execute()
        )
        if existing.data:
            return jsonify(error="You’ve already applied for this role."), 409

        application_result = supabase_admin.table("applications").insert({
            "project_id": project_id,
            "role_id": role_id,
            "applicant_id": str(user.id),
            "pitch_message": pitch_message,
            "status": "pending",
        }).execute()
        return jsonify(application_result.data[0]), 201
    except Exception:
        app.logger.exception("Could not submit application")
        return jsonify(error="Could not submit your application. Check the backend log and database schema."), 500


@app.get("/api/owner/applications")
def list_owner_applications():
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        return jsonify(error="Sign in to view your applications."), 401
    try:
        user = supabase.auth.get_user(token).user
        if user is None:
            return jsonify(error="Your session is invalid. Please sign in again."), 401

        owned_projects = (
            supabase_admin.table("projects")
            .select("id, title")
            .eq("owner_id", str(user.id))
            .execute()
        ).data
        projects_by_id = {str(project["id"]): project["title"] for project in owned_projects}
        project_ids = list(projects_by_id)
        if not project_ids:
            return jsonify([])

        applications = (
            supabase_admin.table("applications")
            .select("id, project_id, role_id, applicant_id, pitch_message, status, applied_at, reviewed_at, project_roles(role_name)")
            .in_("project_id", project_ids)
            .order("applied_at", desc=True)
            .execute()
        ).data

        response = []
        for application in applications:
            applicant = auth_user_by_id(application["applicant_id"])
            response.append({
                **application,
                "project_title": projects_by_id.get(str(application["project_id"]), "Project"),
                "role_name": (application.get("project_roles") or {}).get("role_name", "Team role"),
                "applicant_email": applicant.email if applicant else "Unknown applicant",
                "applicant_profile": public_profile(applicant) if applicant else {},
            })
        return jsonify(response)
    except Exception:
        app.logger.exception("Could not load owner applications")
        return jsonify(error="Could not load applications."), 500


@app.get("/api/my/applications")
def list_my_applications():
    """List only the signed-in user's own applications and their latest status."""
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        return jsonify(error="Sign in to track your applications."), 401
    try:
        user = supabase.auth.get_user(token).user
        if user is None:
            return jsonify(error="Your session is invalid. Please sign in again."), 401

        applications = supabase_admin.table("applications").select(
            "id, project_id, role_id, pitch_message, status, applied_at, reviewed_at"
        ).eq("applicant_id", str(user.id)).order("applied_at", desc=True).execute().data
        if not applications:
            return jsonify([])

        project_ids = list({str(item["project_id"]) for item in applications})
        role_ids = list({str(item["role_id"]) for item in applications})
        try:
            projects = supabase_admin.table("projects").select(
                "id, title, status, is_active"
            ).in_("id", project_ids).execute().data
        except Exception:
            # Keep tracking available for databases where the optional lifecycle
            # migration has not been applied yet.
            projects = supabase_admin.table("projects").select(
                "id, title, is_active"
            ).in_("id", project_ids).execute().data
            for project in projects:
                project["status"] = "open" if project.get("is_active") else "closed"

        roles = supabase_admin.table("project_roles").select(
            "id, project_id, role_name"
        ).in_("id", role_ids).execute().data
        projects_by_id = {str(item["id"]): item for item in projects}
        roles_by_id = {str(item["id"]): item for item in roles}

        response = []
        for application in applications:
            project = projects_by_id.get(str(application["project_id"]), {})
            role = roles_by_id.get(str(application["role_id"]), {})
            response.append({
                **application,
                "project_title": project.get("title", "Project no longer available"),
                "project_status": project.get("status", "unknown"),
                "project_is_active": project.get("is_active", False),
                "role_name": role.get("role_name", "Team role"),
            })
        return jsonify(response)
    except Exception:
        app.logger.exception("Could not load the user's applications")
        return jsonify(error="Could not load your applications."), 500


@app.get("/api/my/projects")
def list_my_projects():
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        return jsonify(error="Sign in to view your projects."), 401
    try:
        user = supabase.auth.get_user(token).user
        if user is None:
            return jsonify(error="Your session is invalid. Please sign in again."), 401

        owned = supabase_admin.table("projects").select("id").eq("owner_id", str(user.id)).execute().data
        memberships = supabase_admin.table("project_members").select("project_id, role_id").eq("user_id", str(user.id)).execute().data
        project_ids = list({str(row["id"]) for row in owned} | {str(row["project_id"]) for row in memberships})
        if not project_ids:
            return jsonify([])

        try:
            projects = supabase_admin.table("projects").select(
                "id, title, description, tech_stack, owner_id, status, is_active, created_at, project_roles(id, role_name, slots_total, slots_filled)"
            ).in_("id", project_ids).order("created_at", desc=True).execute().data
        except Exception:
            app.logger.warning("Project status migration is not available; loading legacy project fields")
            projects = supabase_admin.table("projects").select(
                "id, title, description, tech_stack, owner_id, is_active, created_at, project_roles(id, role_name, slots_total, slots_filled)"
            ).in_("id", project_ids).order("created_at", desc=True).execute().data
            for project in projects:
                project["status"] = "open" if project.get("is_active") else "closed"
        owned_ids = {str(row["id"]) for row in owned}
        member_rows = supabase_admin.table("project_members").select("project_id, role_id").in_("project_id", project_ids).execute().data
        member_counts = {}
        for row in member_rows:
            key = str(row["project_id"])
            member_counts[key] = member_counts.get(key, 0) + 1
        my_roles_by_project = {}
        role_name_by_id = {
            str(role["id"]): role["role_name"]
            for project in projects
            for role in project.get("project_roles", [])
        }
        for membership in memberships:
            key = str(membership["project_id"])
            my_roles_by_project.setdefault(key, []).append(role_name_by_id.get(str(membership["role_id"]), "Team member"))

        for project in projects:
            key = str(project["id"])
            project["is_owner"] = key in owned_ids
            project["my_roles"] = my_roles_by_project.get(key, [])
            project["members_count"] = member_counts.get(key, 0)
        return jsonify(projects)
    except Exception:
        app.logger.exception("Could not load the user's projects")
        return jsonify(error="Could not load your projects."), 500


@app.post("/api/applications/<int:application_id>/review")
def review_application(application_id):
    if supabase is None or supabase_admin is None:
        return jsonify(error="Backend Supabase settings are incomplete."), 503
    token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
    if not token:
        return jsonify(error="Sign in to review applications."), 401
    try:
        user = supabase.auth.get_user(token).user
        if user is None:
            return jsonify(error="Your session is invalid. Please sign in again."), 401
        decision = (request.get_json(silent=True) or {}).get("decision")
        if decision not in {"accepted", "declined"}:
            return jsonify(error="Choose accept or decline."), 400

        application = (
            supabase_admin.table("applications")
            .select("id, project_id, role_id, applicant_id, status")
            .eq("id", application_id)
            .maybe_single()
            .execute()
        ).data
        if not application:
            return jsonify(error="Application not found."), 404
        project = (
            supabase_admin.table("projects")
            .select("id, owner_id")
            .eq("id", application["project_id"])
            .maybe_single()
            .execute()
        ).data
        if not project or str(project["owner_id"]) != str(user.id):
            return jsonify(error="Only this project’s creator can review the application."), 403
        if application["status"] != "pending":
            return jsonify(error="This application has already been reviewed."), 409

        reviewed_at = datetime.now(timezone.utc).isoformat()
        if decision == "declined":
            supabase_admin.table("applications").update({
                "status": "declined", "reviewed_at": reviewed_at,
            }).eq("id", application_id).eq("status", "pending").execute()
            return jsonify(message="Application declined.")

        role = (
            supabase_admin.table("project_roles")
            .select("id, slots_total, slots_filled")
            .eq("id", application["role_id"])
            .eq("project_id", application["project_id"])
            .maybe_single()
            .execute()
        ).data
        if not role or int(role["slots_filled"] or 0) >= int(role["slots_total"] or 0):
            return jsonify(error="This role has no openings left."), 409

        membership = supabase_admin.table("project_members").insert({
            "project_id": application["project_id"],
            "role_id": application["role_id"],
            "user_id": application["applicant_id"],
        }).execute()
        filled_before = int(role["slots_filled"] or 0)
        slot_update = (
            supabase_admin.table("project_roles")
            .update({"slots_filled": filled_before + 1})
            .eq("id", application["role_id"])
            .eq("slots_filled", filled_before)
            .select("id")
            .execute()
        )
        if not slot_update.data:
            supabase_admin.table("project_members").delete().eq("project_id", application["project_id"]).eq("role_id", application["role_id"]).eq("user_id", application["applicant_id"]).execute()
            return jsonify(error="That opening was just filled. Refresh and review another application."), 409

        supabase_admin.table("applications").update({
            "status": "accepted", "reviewed_at": reviewed_at,
        }).eq("id", application_id).eq("status", "pending").execute()
        return jsonify(message="Applicant accepted and added to the project team.")
    except Exception:
        app.logger.exception("Could not review application")
        return jsonify(error="Could not review this application. Check the backend log and database schema."), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000)
