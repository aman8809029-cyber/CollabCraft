-- Public GitHub repository links and an index for the newest open projects.
-- Safe to run more than once in the Supabase SQL Editor.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS github_url text;

CREATE INDEX IF NOT EXISTS projects_active_created_at_idx
  ON public.projects (created_at DESC)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS project_roles_project_id_idx
  ON public.project_roles (project_id);
