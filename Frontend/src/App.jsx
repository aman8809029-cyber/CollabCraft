import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabase";
import "./App.css";

const API_URL = import.meta.env.VITE_API_URL || "http://127.0.0.1:5000";
const ROLE_FILTERS = ["All roles", "Design", "Frontend", "Backend", "Mobile"];

function matchesRole(roleName, category) {
  if (category === "All roles") return true;
  const role = roleName.toLowerCase();
  const groups = {
    Design: ["design", "ux", "ui", "product"],
    Frontend: ["frontend", "front-end", "react", "vue", "web"],
    Backend: ["backend", "back-end", "python", "api", "database", "server"],
    Mobile: ["mobile", "react native", "ios", "android", "flutter"],
  };
  return groups[category]?.some((term) => role.includes(term)) ?? false;
}

function roleOpenings(role) {
  return Math.max(0, Number(role.slots_total || 0) - Number(role.slots_filled || 0));
}

function ProjectCard({ project, onOpen }) {
  const roles = project.project_roles || [];
  const stack = Array.isArray(project.tech_stack) ? project.tech_stack : [];
  const openRoleCount = roles.reduce((total, role) => total + roleOpenings(role), 0);

  return (
    <article className="project-card">
      <div className="project-card-top">
        <span className="project-type"><span className="type-dot" /> SIDE PROJECT</span>
        <span className={`open-status ${openRoleCount === 0 ? "team-full-status" : ""}`}>
          {openRoleCount > 0 ? `${openRoleCount} ${openRoleCount === 1 ? "OPENING" : "OPENINGS"}` : "TEAM FULL"}
        </span>
      </div>
      <div className="project-card-copy">
        <h3>{project.title}</h3>
        <p>{project.description}</p>
      </div>
      {stack.length > 0 && (
        <div className="tech-tags" aria-label="Technology stack">
          {stack.slice(0, 4).map((tech) => <span className="tech-tag" key={tech}>{tech}</span>)}
        </div>
      )}
      <div className="role-list">
        {roles.length ? roles.map((role) => {
          const openings = roleOpenings(role);
          return (
            <div className="role-row" key={role.id}>
              <span className="role-icon" aria-hidden="true">{role.role_name.toLowerCase().includes("design") ? "✳" : "⌘"}</span>
              <strong>{role.role_name}</strong>
              <span className="role-count">{openings} {openings === 1 ? "opening" : "openings"}</span>
            </div>
          );
        }) : <p className="no-roles">No open roles listed yet.</p>}
      </div>
      <button className="project-open-button" type="button" onClick={() => onOpen(project)}>
        View project <span aria-hidden="true">→</span>
      </button>
    </article>
  );
}

function GithubRepoPreview({ repoUrl }) {
  const [repo, setRepo] = useState(null);
  const [latestCommit, setLatestCommit] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function loadPreview() {
    setLoading(true);
    setError("");
    try {
      const parsedUrl = new URL(repoUrl);
      const [owner, repository] = parsedUrl.pathname.split("/").filter(Boolean);
      if (parsedUrl.hostname !== "github.com" || !owner || !repository) throw new Error("This GitHub repository link is invalid.");
      const repositoryPath = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
      const [repoResponse, commitsResponse] = await Promise.all([
        fetch(repositoryPath, { headers: { Accept: "application/vnd.github+json" } }),
        fetch(`${repositoryPath}/commits?per_page=1`, { headers: { Accept: "application/vnd.github+json" } }),
      ]);
      const [repoData, commitsData] = await Promise.all([repoResponse.json(), commitsResponse.json()]);
      if (!repoResponse.ok) throw new Error(repoData.message || "Could not load this repository. Check that it is public.");
      if (!commitsResponse.ok) throw new Error(commitsData.message || "Could not load recent repository activity.");
      setRepo(repoData);
      setLatestCommit(Array.isArray(commitsData) ? commitsData[0] || null : null);
    } catch (loadError) {
      setError(loadError?.message || "Could not load the GitHub repository preview.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="github-repo-card" aria-label="GitHub repository">
      <div className="github-repo-heading"><div><p className="eyebrow">BUILD TOGETHER</p><h3>GitHub repository</h3><p>Load a public repository overview and latest commit when you need it.</p></div><span className="github-mark" aria-hidden="true">GH</span></div>
      <a className="github-repo-link" href={repoUrl} target="_blank" rel="noreferrer">{repoUrl}<span aria-hidden="true">↗</span></a>
      {!repo && <button className="outline-button github-load-button" type="button" onClick={loadPreview} disabled={loading}>{loading ? "Loading repository…" : "Load repository preview"}</button>}
      {error && <p className="form-message github-error" role="alert">{error}</p>}
      {repo && <div className="github-repo-details">
        {repo.description && <p className="github-description">{repo.description}</p>}
        <div className="github-repo-stats"><span>{repo.language || "Repository"}</span><span>★ {repo.stargazers_count}</span><span>{repo.forks_count} forks</span></div>
        <div className="github-repo-actions"><a href={`${repo.html_url}#readme`} target="_blank" rel="noreferrer">Read README ↗</a><a href={`${repo.html_url}/issues`} target="_blank" rel="noreferrer">Issues ↗</a></div>
        {latestCommit && <a className="github-latest-commit" href={latestCommit.html_url} target="_blank" rel="noreferrer"><span>LATEST COMMIT</span><strong>{latestCommit.commit.message.split("\n")[0]}</strong><time>{latestCommit.commit.author?.date ? new Date(latestCommit.commit.author.date).toLocaleDateString() : "Recently"}</time></a>}
      </div>}
    </section>
  );
}

function ProfilePage({ session, onProfileUpdated, onExplore, onSignIn }) {
  const metadata = session?.user?.user_metadata || {};
  const [form, setForm] = useState({
    display_name: metadata.display_name || "",
    skills: metadata.skills || "",
    bio: metadata.bio || "",
    portfolio_url: metadata.portfolio_url || "",
  });
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function saveProfile(event) {
    event.preventDefault();
    setSaving(true);
    setMessage("");
    setError("");
    const profile = {
      display_name: form.display_name.trim().toUpperCase(),
      skills: form.skills.trim().toUpperCase(),
      bio: form.bio.trim().toUpperCase(),
      portfolio_url: form.portfolio_url.trim(),
    };
    try {
      const { data, error: updateError } = await supabase.auth.updateUser({ data: profile });
      if (updateError) throw updateError;
      onProfileUpdated(data.user);
      setForm(profile);
      setMessage("Your profile is saved.");
    } catch (saveError) {
      setError(saveError?.message || "Could not save your profile. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  if (!session) {
    return <section className="applications-page profile-page"><div className="applications-heading"><p className="eyebrow">YOUR PROFILE</p><h1>Member profile</h1><p>Sign in to create a profile that teammates and project creators can see.</p></div><button className="primary-button" type="button" onClick={onSignIn}>Sign in to continue</button></section>;
  }

  return (
    <section className="applications-page profile-page">
      <button className="back-link" type="button" onClick={onExplore}>← Back to Explore</button>
      <div className="applications-heading"><p className="eyebrow">YOUR PROFILE</p><h1>Tell your team about you</h1><p>Your name, skills, bio, and portfolio help people understand what you bring to a project.</p></div>
      <form className="profile-form" onSubmit={saveProfile}>
        <label>Display name<input maxLength="80" autoComplete="name" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value.toUpperCase() })} placeholder="HOW SHOULD PEOPLE ADDRESS YOU?" required /></label>
        <label>Skills<input maxLength="240" value={form.skills} onChange={(event) => setForm({ ...form, skills: event.target.value.toUpperCase() })} placeholder="E.G. REACT, UI DESIGN, PYTHON" /></label>
        <label>Short bio<textarea maxLength="500" rows="5" value={form.bio} onChange={(event) => setForm({ ...form, bio: event.target.value.toUpperCase() })} placeholder="A LITTLE ABOUT YOU AND WHAT YOU LIKE TO BUILD" /></label>
        <label>Portfolio link <span className="profile-optional">OPTIONAL</span><input type="url" maxLength="500" value={form.portfolio_url} onChange={(event) => setForm({ ...form, portfolio_url: event.target.value })} placeholder="HTTPS://…" /></label>
        <p className="profile-privacy-note">Your profile details are visible to people viewing teams you’ve joined and creators reviewing your applications. Your email visibility follows the existing project access rules.</p>
        {message && <p className="form-message profile-success" role="status">{message}</p>}
        {error && <p className="form-message" role="alert">{error}</p>}
        <button className="primary-button" type="submit" disabled={saving || !form.display_name.trim()}>{saving ? "Saving profile…" : "Save profile"}</button>
      </form>
    </section>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const logoutRequested = useRef(false);
  const [activeView, setActiveView] = useState("explore");
  const [projects, setProjects] = useState([]);
  const [projectsPage, setProjectsPage] = useState(1);
  const [projectsHasMore, setProjectsHasMore] = useState(false);
  const [loadingMoreProjects, setLoadingMoreProjects] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("All roles");
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState("signin");
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const [signingUp, setSigningUp] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [notice, setNotice] = useState("");
  const [selectedProject, setSelectedProject] = useState(null);
  const [projectEditOpen, setProjectEditOpen] = useState(false);
  const [savingProjectEdit, setSavingProjectEdit] = useState(false);
  const [projectEditMessage, setProjectEditMessage] = useState("");
  const [projectEditForm, setProjectEditForm] = useState({ title: "", description: "", tech_stack: "", github_url: "", roles: [] });
  const [projectDetailsLoading, setProjectDetailsLoading] = useState(false);
  const [projectDetailsError, setProjectDetailsError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [projectMessage, setProjectMessage] = useState("");
  const [projectForm, setProjectForm] = useState({ title: "", description: "", tech_stack: "", github_url: "", roles: [{ role_name: "", slots_total: 1 }] });
  const [applyTarget, setApplyTarget] = useState(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const [pitchMessage, setPitchMessage] = useState("");
  const [submittingApplication, setSubmittingApplication] = useState(false);
  const [applicationMessage, setApplicationMessage] = useState("");
  const [ownerApplications, setOwnerApplications] = useState([]);
  const [myApplications, setMyApplications] = useState([]);
  const [myApplicationsLoading, setMyApplicationsLoading] = useState(false);
  const [myApplicationsError, setMyApplicationsError] = useState("");
  const [applicationMode, setApplicationMode] = useState("received");
  const [myApplicationStatusFilter, setMyApplicationStatusFilter] = useState("all");
  const [applicationRefreshKey, setApplicationRefreshKey] = useState(0);
  const [applicationProjectFilter, setApplicationProjectFilter] = useState("All projects");
  const [applicationsLoading, setApplicationsLoading] = useState(false);
  const [applicationsError, setApplicationsError] = useState("");
  const [reviewingApplicationId, setReviewingApplicationId] = useState(null);
  const [myProjects, setMyProjects] = useState([]);
  const [myProjectsLoading, setMyProjectsLoading] = useState(false);
  const [myProjectsError, setMyProjectsError] = useState("");
  const [workspace, setWorkspace] = useState({ work_items: [], feedback: [], tasks: [], team_members: [], access: null, task_board_available: false });
  const [workspaceError, setWorkspaceError] = useState("");
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const [workTitle, setWorkTitle] = useState("");
  const [workDescription, setWorkDescription] = useState("");
  const [workFile, setWorkFile] = useState(null);
  const [savingWork, setSavingWork] = useState(false);
  const [editingWorkId, setEditingWorkId] = useState(null);
  const [editingWorkForm, setEditingWorkForm] = useState({ title: "", description: "" });
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDescription, setTaskDescription] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [savingTask, setSavingTask] = useState(false);
  const [updatingTaskId, setUpdatingTaskId] = useState(null);
  const [feedbackKind, setFeedbackKind] = useState("comment");
  const [feedbackBody, setFeedbackBody] = useState("");
  const [savingFeedback, setSavingFeedback] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [chatError, setChatError] = useState("");
  const [sendingChat, setSendingChat] = useState(false);
  const [changingProjectStatus, setChangingProjectStatus] = useState(false);
  const searchInputRef = useRef(null);
  const projectDetailsBackdropRef = useRef(null);
  const projectChatListRef = useRef(null);
  const chatShouldStickToBottomRef = useRef(true);
  const chatCursorRef = useRef(0);
  const chatLoadedRef = useRef(false);
  const chatRequestInFlightRef = useRef(false);
  const accountMenuRef = useRef(null);
  const overlayOpen = authOpen || createOpen || applyOpen || Boolean(selectedProject);
  const selectedProjectId = selectedProject?.id ?? null;

  useEffect(() => {
    if (!selectedProjectId || !session?.access_token || !["creator", "member"].includes(workspace.access)) return undefined;
    let cancelled = false;
    chatCursorRef.current = 0;
    chatLoadedRef.current = false;
    async function refreshChat() {
      if (document.visibilityState !== "visible" || chatRequestInFlightRef.current) return;
      chatRequestInFlightRef.current = true;
      try {
        const cursorQuery = chatLoadedRef.current ? `?after_id=${chatCursorRef.current}` : "";
        const response = await fetch(`${API_URL}/api/projects/${selectedProjectId}/chat${cursorQuery}`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
        if (!cancelled) {
          const incoming = Array.isArray(result.messages) ? result.messages : [];
          if (!chatLoadedRef.current || incoming.length > 0) {
            setChatMessages((current) => {
              const merged = new Map((chatLoadedRef.current ? current : []).map((message) => [String(message.id), message]));
              incoming.forEach((message) => merged.set(String(message.id), message));
              return [...merged.values()].sort((first, second) => Number(first.id) - Number(second.id)).slice(-100);
            });
          }
          chatCursorRef.current = Math.max(chatCursorRef.current, Number(result.cursor) || 0);
          chatLoadedRef.current = true;
          setChatError("");
        }
      } catch (loadError) {
        if (!cancelled) setChatError(loadError?.message || "Could not load team chat.");
      } finally {
        chatRequestInFlightRef.current = false;
      }
    }
    refreshChat();
    const timer = window.setInterval(refreshChat, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [selectedProjectId, session?.access_token, workspace.access]);

  useEffect(() => {
    if (projectChatListRef.current && chatShouldStickToBottomRef.current) {
      projectChatListRef.current.scrollTop = projectChatListRef.current.scrollHeight;
    }
  }, [chatMessages]);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (logoutRequested.current && nextSession) return;
      setSession(nextSession);
      if (!nextSession) setAccountMenuOpen(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!accountMenuOpen) return undefined;
    function closeAccountMenuOnOutsideClick(event) {
      if (!accountMenuRef.current?.contains(event.target)) setAccountMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeAccountMenuOnOutsideClick);
    return () => document.removeEventListener("pointerdown", closeAccountMenuOnOutsideClick);
  }, [accountMenuOpen]);

  useEffect(() => {
    function handleShortcut(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setActiveView("explore");
        window.requestAnimationFrame(() => searchInputRef.current?.focus());
      }
      if (event.key === "Escape") {
        if (authOpen) setAuthOpen(false);
        else if (applyOpen) setApplyOpen(false);
        else if (createOpen && !publishing) setCreateOpen(false);
        else if (projectEditOpen && !savingProjectEdit) setProjectEditOpen(false);
        else if (selectedProject) { setProjectEditOpen(false); setSelectedProject(null); }
        else setAccountMenuOpen(false);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [authOpen, applyOpen, createOpen, publishing, projectEditOpen, savingProjectEdit, selectedProject]);

  useEffect(() => {
    if (!overlayOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [overlayOpen]);

  useEffect(() => {
    if (selectedProjectId === null) return;
    window.requestAnimationFrame(() => {
      if (projectDetailsBackdropRef.current) projectDetailsBackdropRef.current.scrollTop = 0;
    });
  }, [selectedProjectId]);

  useEffect(() => {
    if (activeView !== "applications" || !session?.access_token) return undefined;
    let cancelled = false;
    fetch(`${API_URL}/api/owner/applications`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
        return data;
      })
      .then((data) => { if (!cancelled) setOwnerApplications(Array.isArray(data) ? data : []); })
      .catch((loadError) => { if (!cancelled) setApplicationsError(loadError?.message || "Could not load applications."); })
      .finally(() => { if (!cancelled) setApplicationsLoading(false); });
    return () => { cancelled = true; };
  }, [activeView, session, applicationRefreshKey]);

  useEffect(() => {
    if (activeView !== "applications" || !session?.access_token) return undefined;
    let cancelled = false;
    fetch(`${API_URL}/api/my/applications`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
        return data;
      })
      .then((data) => { if (!cancelled) setMyApplications(Array.isArray(data) ? data : []); })
      .catch((loadError) => { if (!cancelled) setMyApplicationsError(loadError?.message || "Could not load your applications."); })
      .finally(() => { if (!cancelled) setMyApplicationsLoading(false); });
    return () => { cancelled = true; };
  }, [activeView, session, applicationRefreshKey]);

  useEffect(() => {
    if (activeView !== "my-projects" || !session?.access_token) return undefined;
    let cancelled = false;
    fetch(`${API_URL}/api/my/projects`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
        return data;
      })
      .then((data) => { if (!cancelled) setMyProjects(Array.isArray(data) ? data : []); })
      .catch((loadError) => { if (!cancelled) setMyProjectsError(loadError?.message || "Could not load your projects."); })
      .finally(() => { if (!cancelled) setMyProjectsLoading(false); });
    return () => { cancelled = true; };
  }, [activeView, session]);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_URL}/api/projects?page=1&per_page=12`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Backend returned ${response.status}`);
        const data = await response.json();
        return { data, hasMore: response.headers.get("X-Has-More") === "true" };
      })
      .then(({ data, hasMore }) => {
        if (!cancelled) {
          setProjects(Array.isArray(data) ? data : []);
          setProjectsPage(1);
          setProjectsHasMore(hasMore);
        }
      })
      .catch((err) => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const visibleProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    return projects.filter((project) => {
      const roles = project.project_roles || [];
      const techStack = Array.isArray(project.tech_stack) ? project.tech_stack : [];
      const searchable = [
        project.title,
        project.description,
        ...techStack,
        ...roles.map((role) => role.role_name),
      ].join(" ").toLowerCase();
      const matchesSearch = !query || searchable.includes(query);
      const matchesCategory = roleFilter === "All roles" || roles.some((role) => matchesRole(role.role_name, roleFilter));
      return matchesSearch && matchesCategory;
    });
  }, [projects, search, roleFilter]);

  const applicationProjectNames = useMemo(
    () => [...new Set(ownerApplications.map((application) => application.project_title))],
    [ownerApplications],
  );
  const visibleApplications = useMemo(
    () => applicationProjectFilter === "All projects"
      ? ownerApplications
      : ownerApplications.filter((application) => application.project_title === applicationProjectFilter),
    [ownerApplications, applicationProjectFilter],
  );

  async function loadMoreProjects() {
    if (loadingMoreProjects || !projectsHasMore) return;
    const nextPage = projectsPage + 1;
    setLoadingMoreProjects(true);
    setLoadMoreError("");
    try {
      const response = await fetch(`${API_URL}/api/projects?page=${nextPage}&per_page=12`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      setProjects((current) => {
        const knownIds = new Set(current.map((project) => String(project.id)));
        return [...current, ...(Array.isArray(data) ? data.filter((project) => !knownIds.has(String(project.id))) : [])];
      });
      setProjectsPage(nextPage);
      setProjectsHasMore(response.headers.get("X-Has-More") === "true");
    } catch (loadError) {
      setLoadMoreError(loadError?.message || "Could not load more projects.");
    } finally {
      setLoadingMoreProjects(false);
    }
  }

  async function handleSignIn(event) {
    event.preventDefault();
    setSigningIn(true);
    setAuthMessage("");

    try {
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (signInError) throw signInError;
      if (!data.session) throw new Error("Supabase did not return a sign-in session.");

      logoutRequested.current = false;
      setSession(data.session);
      setAuthMessage("Signed in successfully.");
      setNotice("Signed in successfully.");
      window.setTimeout(() => {
        setAuthOpen(false);
        if (applyTarget) setApplyOpen(true);
      }, 700);
    } catch (error) {
      setAuthMessage(error?.message || "Sign-in failed. Check your email and password.");
    } finally {
      setSigningIn(false);
    }
  }

  async function handleSignUp(event) {
    event.preventDefault();
    setSigningUp(true);
    setAuthMessage("");
    try {
      const { data, error: signUpError } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (signUpError) throw signUpError;
      if (data.session) {
        logoutRequested.current = false;
        setSession(data.session);
        setAuthMessage("Account created and signed in.");
        setNotice("Your CollabCraft account is ready.");
        window.setTimeout(() => {
          setAuthOpen(false);
          if (applyTarget) setApplyOpen(true);
        }, 700);
      } else {
        setAuthMode("signin");
        setPassword("");
        setAuthMessage("Account created. Check your email to confirm it, then sign in.");
      }
    } catch (error) {
      setAuthMessage(error?.message || "Could not create your account.");
    } finally {
      setSigningUp(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    logoutRequested.current = true;
    // Update the interface immediately; Supabase's SIGNED_OUT event will keep it in sync.
    setSession(null);
    setAccountMenuOpen(false);
    setAuthOpen(false);
    setEmail("");
    setPassword("");
    setNotice("You’re signed out.");
    try {
      const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
      if (signOutError) throw signOutError;
      window.location.reload();
    } catch (error) {
      setNotice(`Could not sign out: ${error?.message || "Please try again."}`);
    } finally {
      setSigningOut(false);
    }
  }

  async function handleCreateProject(event) {
    event.preventDefault();
    setProjectMessage("");
    if (!session?.access_token) {
      setCreateOpen(false);
      setAuthOpen(true);
      setAuthMessage("Sign in before publishing a project.");
      return;
    }
    setPublishing(true);
    try {
      const response = await fetch(`${API_URL}/api/projects`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          title: projectForm.title,
          description: projectForm.description,
          tech_stack: projectForm.tech_stack.split(",").map((item) => item.trim()).filter(Boolean),
          github_url: projectForm.github_url,
          roles: projectForm.roles,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setProjects((current) => [{ ...result, project_roles: projectForm.roles.map((role, index) => ({ ...role, id: `${result.id}-${index}`, slots_filled: 0 })) }, ...current]);
      setProjectForm({ title: "", description: "", tech_stack: "", github_url: "", roles: [{ role_name: "", slots_total: 1 }] });
      setCreateOpen(false);
      setNotice("Your project is live in Explore.");
    } catch (createError) {
      setProjectMessage(createError?.message || "Could not publish the project.");
    } finally {
      setPublishing(false);
    }
  }

  function updateRole(index, field, value) {
    setProjectForm((current) => ({
      ...current,
      roles: current.roles.map((role, roleIndex) => roleIndex === index ? { ...role, [field]: field === "slots_total" ? Number(value) : value.toUpperCase() } : role),
    }));
  }

  function startApplication(project, role) {
    setApplyTarget({ project, role });
    setPitchMessage("");
    setApplicationMessage("");
    setSelectedProject(null);
    if (!session) {
      setAuthMessage("Sign in to continue with your application.");
      setAuthOpen(true);
      return;
    }
    setApplyOpen(true);
  }

  async function handleApply(event) {
    event.preventDefault();
    if (!session?.access_token || !applyTarget) return;
    setSubmittingApplication(true);
    setApplicationMessage("");
    try {
      const response = await fetch(`${API_URL}/api/applications`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          project_id: applyTarget.project.id,
          role_id: applyTarget.role.id,
          pitch_message: pitchMessage,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setApplyOpen(false);
      setPitchMessage("");
      setNotice(`Application sent for ${applyTarget.role.role_name}.`);
      setApplyTarget(null);
    } catch (applyError) {
      setApplicationMessage(applyError?.message || "Could not submit your application.");
    } finally {
      setSubmittingApplication(false);
    }
  }

  async function reviewApplication(application, decision) {
    setReviewingApplicationId(application.id);
    try {
      const response = await fetch(`${API_URL}/api/applications/${application.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ decision }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setOwnerApplications((current) => current.map((item) => item.id === application.id ? { ...item, status: decision } : item));
      setNotice(decision === "accepted" ? "Applicant accepted and added to your team." : "Application declined.");
    } catch (reviewError) {
      setNotice(reviewError?.message || "Could not review this application.");
    } finally {
      setReviewingApplicationId(null);
    }
  }

  function openApplications() {
    if (!session) {
      setAuthMode("signin");
      setAuthOpen(true);
      setAuthMessage("Sign in as a project creator to review applications.");
      return;
    }
    setApplicationsLoading(true);
    setApplicationsError("");
    setMyApplicationsLoading(true);
    setMyApplicationsError("");
    setApplicationRefreshKey((current) => current + 1);
    setActiveView("applications");
  }

  function openMyProjects() {
    if (!session) {
      setAuthMode("signin");
      setAuthOpen(true);
      setAuthMessage("Sign in to see projects you created or joined.");
      return;
    }
    setMyProjectsLoading(true);
    setMyProjectsError("");
    setActiveView("my-projects");
  }

  async function openProjectDetails(project) {
    setChatMessages([]);
    setChatDraft("");
    setChatError("");
    chatCursorRef.current = 0;
    chatLoadedRef.current = false;
    chatShouldStickToBottomRef.current = true;
    setSelectedProject(project);
    setProjectDetailsLoading(true);
    setWorkspaceLoading(true);
    setProjectDetailsError("");
    try {
      const headers = session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {};
      const response = await fetch(`${API_URL}/api/projects/${project.id}`, { headers });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
      setSelectedProject(data);
      setWorkspace({ work_items: [], feedback: [], tasks: [], team_members: [], access: null, task_board_available: false });
      if (session?.access_token && data.can_view_project_area) {
        const workspaceResponse = await fetch(`${API_URL}/api/projects/${project.id}/workspace`, {
          headers: { Authorization: `Bearer ${session.access_token}` },
        });
        const workspaceData = await workspaceResponse.json();
        if (!workspaceResponse.ok) throw new Error(workspaceData.error || "Could not load project workspace.");
        setWorkspace({ ...workspaceData, team_members: data.team_members || [] });
      }
    } catch (detailError) {
      setProjectDetailsError(detailError?.message || "Could not load project members.");
    } finally {
      setProjectDetailsLoading(false);
      setWorkspaceLoading(false);
    }
  }

  async function changeProjectStatus(project, status) {
    if (!session?.access_token) return;
    setChangingProjectStatus(true);
    try {
      const response = await fetch(`${API_URL}/api/projects/${project.id}/status`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ status }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setMyProjects((current) => current.map((item) => String(item.id) === String(project.id) ? { ...item, status: result.status, is_active: result.is_active } : item));
      if (selectedProject && String(selectedProject.id) === String(project.id)) setSelectedProject((current) => ({ ...current, status: result.status, is_active: result.is_active }));
      setNotice(`Project marked ${status}.`);
      if (status !== "open") {
        setProjects((current) => current.filter((item) => String(item.id) !== String(project.id)));
      }
    } catch (statusError) {
      setNotice(statusError?.message || "Could not update project status.");
    } finally {
      setChangingProjectStatus(false);
    }
  }

  function beginProjectEdit(project) {
    setProjectEditForm({
      title: project.title || "",
      description: project.description || "",
      tech_stack: Array.isArray(project.tech_stack) ? project.tech_stack.join(", ") : "",
      github_url: project.github_url || "",
      roles: (project.project_roles || []).map((role) => ({
        id: role.id,
        role_name: role.role_name,
        slots_total: Number(role.slots_total),
      })),
    });
    setProjectEditMessage("");
    setProjectEditOpen(true);
  }

  function closeProjectDetails() {
    setProjectEditOpen(false);
    setChatMessages([]);
    setChatDraft("");
    setSelectedProject(null);
  }

  async function handleProjectEdit(event) {
    event.preventDefault();
    if (!session?.access_token || !selectedProject) return;
    setSavingProjectEdit(true);
    setProjectEditMessage("");
    try {
      const response = await fetch(`${API_URL}/api/projects/${selectedProject.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          title: projectEditForm.title,
          description: projectEditForm.description,
          tech_stack: projectEditForm.tech_stack.split(",").map((item) => item.trim()).filter(Boolean),
          github_url: projectEditForm.github_url,
          roles: projectEditForm.roles,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setSelectedProject((current) => ({ ...current, ...result, can_manage_project: true }));
      setProjects((current) => current.map((item) => String(item.id) === String(result.id) ? { ...item, ...result } : item));
      setMyProjects((current) => current.map((item) => String(item.id) === String(result.id) ? { ...item, ...result } : item));
      setProjectEditOpen(false);
      setNotice("Project details updated.");
    } catch (editError) {
      setProjectEditMessage(editError?.message || "Could not update this project.");
    } finally {
      setSavingProjectEdit(false);
    }
  }

  async function handleAddWorkItem(event) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!session?.access_token || !selectedProject) return;
    setSavingWork(true);
    setWorkspaceError("");
    try {
      const formData = new FormData();
      formData.append("title", workTitle);
      formData.append("description", workDescription);
      if (workFile) formData.append("file", workFile);
      const response = await fetch(`${API_URL}/api/projects/${selectedProject.id}/work-items`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: formData,
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setWorkTitle("");
      setWorkDescription("");
      setWorkFile(null);
      formElement.reset();
      const workspaceResponse = await fetch(`${API_URL}/api/projects/${selectedProject.id}/workspace`, { headers: { Authorization: `Bearer ${session.access_token}` } });
      const workspaceData = await workspaceResponse.json();
      if (!workspaceResponse.ok) throw new Error(workspaceData.error || "Uploaded, but could not refresh the workspace.");
      setWorkspace({ ...workspaceData, team_members: selectedProject.team_members || [] });
      setNotice("Work item uploaded to the project workspace.");
    } catch (workError) {
      setWorkspaceError(workError?.message || "Could not add work to the project.");
    } finally {
      setSavingWork(false);
    }
  }

  async function handleSaveWorkEdit(event, itemId) {
    event.preventDefault();
    if (!session?.access_token || !selectedProject) return;
    setSavingWork(true);
    try {
      const response = await fetch(`${API_URL}/api/projects/${selectedProject.id}/work-items/${itemId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(editingWorkForm),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setWorkspace((current) => ({ ...current, work_items: current.work_items.map((item) => item.id === itemId ? { ...item, ...result } : item) }));
      setEditingWorkId(null);
      setNotice("Work item updated.");
    } catch (editError) {
      setWorkspaceError(editError?.message || "Could not update this work item.");
    } finally {
      setSavingWork(false);
    }
  }

  async function handleCreateTask(event) {
    event.preventDefault();
    if (!session?.access_token || !selectedProject) return;
    setSavingTask(true);
    setWorkspaceError("");
    try {
      const response = await fetch(`${API_URL}/api/projects/${selectedProject.id}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ title: taskTitle, description: taskDescription, assigned_to: taskAssignee || null }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setWorkspace((current) => ({ ...current, tasks: [result, ...current.tasks] }));
      setTaskTitle("");
      setTaskDescription("");
      setTaskAssignee("");
      setNotice("Task added to the board.");
    } catch (taskError) {
      setWorkspaceError(taskError?.message || "Could not add this task.");
    } finally {
      setSavingTask(false);
    }
  }

  async function handleUpdateTask(taskId, changes) {
    if (!session?.access_token || !selectedProject) return;
    setUpdatingTaskId(taskId);
    setWorkspaceError("");
    try {
      const response = await fetch(`${API_URL}/api/projects/${selectedProject.id}/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify(changes),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setWorkspace((current) => ({ ...current, tasks: current.tasks.map((task) => String(task.id) === String(taskId) ? { ...task, ...result } : task) }));
    } catch (taskError) {
      setWorkspaceError(taskError?.message || "Could not update this task.");
    } finally {
      setUpdatingTaskId(null);
    }
  }

  async function handleFeedback(event) {
    event.preventDefault();
    if (!session?.access_token || !selectedProject) return;
    setSavingFeedback(true);
    setWorkspaceError("");
    try {
      const response = await fetch(`${API_URL}/api/projects/${selectedProject.id}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ kind: feedbackKind, body: feedbackBody }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setWorkspace((current) => ({ ...current, feedback: [result, ...current.feedback] }));
      setFeedbackBody("");
      setNotice(`${feedbackKind === "comment" ? "Comment" : "Suggestion"} added.`);
    } catch (feedbackError) {
      setWorkspaceError(feedbackError?.message || "Could not add feedback.");
    } finally {
      setSavingFeedback(false);
    }
  }

  async function handleSendChatMessage(event) {
    event.preventDefault();
    if (!session?.access_token || !selectedProject || !chatDraft.trim()) return;
    setSendingChat(true);
    setChatError("");
    try {
      const response = await fetch(`${API_URL}/api/projects/${selectedProject.id}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({ body: chatDraft }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || `Request failed (${response.status})`);
      setChatMessages((current) => [...current.filter((message) => String(message.id) !== String(result.id)), result].slice(-100));
      chatCursorRef.current = Math.max(chatCursorRef.current, Number(result.id) || 0);
      chatLoadedRef.current = true;
      setChatDraft("");
    } catch (sendError) {
      setChatError(sendError?.message || "Could not send this message.");
    } finally {
      setSendingChat(false);
    }
  }

  return (
    <div className="cc-app">
      <header className="topbar">
        <a className="brand" href="#explore" aria-label="CollabCraft home">
          <span className="brand-mark">CC</span><span>CollabCraft</span>
        </a>
        <nav className="main-nav" aria-label="Main navigation">
          <button className={`nav-link ${activeView === "explore" ? "active" : ""}`} type="button" onClick={() => setActiveView("explore")}>Explore</button>
          <button className={`nav-link ${activeView === "my-projects" ? "active" : ""}`} type="button" onClick={openMyProjects}>My Projects</button>
          <button className={`nav-link ${activeView === "applications" ? "active" : ""}`} type="button" onClick={openApplications}>Applications</button>
          {session && <button className={`nav-link ${activeView === "profile" ? "active" : ""}`} type="button" onClick={() => setActiveView("profile")}>Profile</button>}
        </nav>
        <div className="account-area">
          {session ? (
            <div className="account-menu" ref={accountMenuRef}>
              <button className="account-trigger" type="button" aria-expanded={accountMenuOpen} onClick={() => setAccountMenuOpen((open) => !open)}>
                <span className="user-avatar">{(session.user.email || "A").slice(0, 1).toUpperCase()}</span><span className="account-email">{session.user.email}</span><span className="chevron">⌄</span>
              </button>
              {accountMenuOpen && <div className="account-popover"><span className="signed-in-label">SIGNED IN</span><strong>{session.user.email}</strong><button type="button" disabled={signingOut} onClick={handleSignOut}>{signingOut ? "Signing out…" : "Sign out"}</button></div>}
            </div>
          ) : (
            <button className="sign-in-button" type="button" onClick={() => { setAuthMode("signin"); setAuthOpen(true); setAuthMessage(""); }}>Sign in <span aria-hidden="true">↗</span></button>
          )}
        </div>
      </header>

      <main className="page-content" id="explore">
        {activeView === "explore" ? <>
        <section className="hero-section">
          <div className="hero-glow" aria-hidden="true" />
          <div className="hero-copy">
            <p className="eyebrow"><span className="eyebrow-line" /> BUILD SOMETHING WITH GOOD PEOPLE</p>
            <h1>Find your people.<br /><span>Build your idea.</span></h1>
            <p className="hero-subtitle">Discover small projects looking for your skills.</p>
          </div>
          <div className="hero-action">
            <p>A spark of an idea.<br />A team to make it real.</p>
            <button className="primary-button" type="button" onClick={() => { setProjectMessage(""); setCreateOpen(true); }}>＋ <span>Create a project</span></button>
          </div>
          <div className="hero-orbit orbit-large" aria-hidden="true" />
          <div className="hero-orbit orbit-small" aria-hidden="true" />
        </section>

        <section className="discovery" aria-label="Find projects">
          <label className="search-box">
            <span className="search-icon" aria-hidden="true">⌕</span>
            <span className="sr-only">Search projects</span>
          <input ref={searchInputRef} type="search" aria-label="Search projects, skills, or ideas" placeholder="Search projects, skills, or ideas" value={search} onChange={(event) => setSearch(event.target.value.toUpperCase())} />
            {search ? <button className="clear-search" type="button" aria-label="Clear search" onClick={() => { setSearch(""); searchInputRef.current?.focus(); }}>×</button> : <kbd>⌘ K</kbd>}
          </label>
          <div className="filter-row" role="group" aria-label="Filter projects by role">
            {ROLE_FILTERS.map((filter) => (
              <button key={filter} type="button" className={`filter-chip ${roleFilter === filter ? "selected" : ""}`} aria-pressed={roleFilter === filter} onClick={() => setRoleFilter(filter)}>{filter}</button>
            ))}
          </div>
        </section>

        <section className="projects-section" aria-live="polite">
          <div className="section-heading">
            <div><p className="eyebrow section-eyebrow">THE COMMUNITY BOARD</p><h2>Projects looking for teammates</h2></div>
            <span className="project-total">{loading ? "Loading…" : `${visibleProjects.length} ${visibleProjects.length === 1 ? "project" : "projects"}`}</span>
          </div>

          {loading && <div className="state-panel"><span className="loading-dot" /> Finding projects…</div>}
          {!loading && error && <div className="state-panel error-panel"><strong>Couldn’t load projects</strong><p>{error}</p><button className="outline-button" onClick={() => window.location.reload()} type="button">Try again</button></div>}
          {!loading && !error && projects.length === 0 && <div className="state-panel"><strong>No projects yet</strong><p>Be the first to share an idea and find your team.</p></div>}
          {!loading && !error && projects.length > 0 && visibleProjects.length === 0 && <div className="state-panel"><strong>No matching projects</strong><p>Try another search or role filter, or load more projects.</p></div>}
          {!loading && !error && visibleProjects.length > 0 && (
            <div className="project-grid">
              {visibleProjects.map((project) => <ProjectCard key={project.id} project={project} onOpen={openProjectDetails} />)}
            </div>
          )}
          {!loading && !error && projectsHasMore && <div className="load-more-projects"><button className="outline-button" type="button" onClick={loadMoreProjects} disabled={loadingMoreProjects}>{loadingMoreProjects ? "Loading projects…" : "Load more projects"}</button>{loadMoreError && <p className="form-message" role="alert">{loadMoreError}</p>}</div>}
        </section>
        </> : activeView === "profile" ? (
          <ProfilePage key={session?.user?.id || "anonymous"} session={session} onProfileUpdated={(user) => setSession((current) => current ? { ...current, user } : current)} onExplore={() => setActiveView("explore")} onSignIn={() => { setAuthMode("signin"); setAuthOpen(true); setAuthMessage(""); }} />
        ) : activeView === "applications" ? (
          <section className="applications-page" aria-live="polite">
            <button className="back-link" type="button" onClick={() => setActiveView("explore")}>← Back to Projects</button>
            <div className="applications-heading">
              <p className="eyebrow">CREATOR WORKSPACE</p>
              <h1>Applications</h1>
              <p>Review applicants for your projects or check the status of your own applications.</p>
            </div>
            <div className="application-mode-tabs" role="tablist" aria-label="Choose applications to view">
              <button type="button" role="tab" aria-selected={applicationMode === "received"} className={`filter-chip ${applicationMode === "received" ? "selected" : ""}`} onClick={() => setApplicationMode("received")}>For my projects <span>{ownerApplications.filter((item) => item.status === "pending").length}</span></button>
              <button type="button" role="tab" aria-selected={applicationMode === "sent"} className={`filter-chip ${applicationMode === "sent" ? "selected" : ""}`} onClick={() => setApplicationMode("sent")}>My applications <span>{myApplications.length}</span></button>
            </div>
            {applicationMode === "received" && <>
            <div className="dashboard-project-tabs" role="tablist" aria-label="Filter applications by project">
              {["All projects", ...applicationProjectNames].map((name) => <button key={name} type="button" role="tab" aria-selected={applicationProjectFilter === name} className={`filter-chip ${applicationProjectFilter === name ? "selected" : ""}`} onClick={() => setApplicationProjectFilter(name)}>{name}</button>)}
            </div>
            <div className="applications-list-heading"><h2>Pending applications</h2><span>{visibleApplications.filter((item) => item.status === "pending").length} waiting</span></div>
            {applicationsLoading && <div className="state-panel"><span className="loading-dot" /> Loading applications…</div>}
            {!applicationsLoading && applicationsError && <div className="state-panel error-panel"><strong>Couldn’t load applications</strong><p>{applicationsError}</p><button className="outline-button" type="button" onClick={() => setActiveView("explore")}>Back to Explore</button></div>}
            {!applicationsLoading && !applicationsError && ownerApplications.length === 0 && <div className="state-panel"><strong>No applications yet</strong><p>Applications for projects you create will appear here.</p></div>}
            {!applicationsLoading && !applicationsError && ownerApplications.length > 0 && visibleApplications.length === 0 && <div className="state-panel"><strong>No applications for this project</strong><p>Choose another project to review its applications.</p></div>}
            {!applicationsLoading && !applicationsError && visibleApplications.length > 0 && (
              <div className="applications-list">
                {visibleApplications.map((application) => (
                  <article className="application-card" key={application.id}>
                    <div className="applicant-avatar">{(application.applicant_profile?.display_name || application.applicant_email || "?").slice(0, 1).toUpperCase()}</div>
                    <div className="application-copy">
                      <div className="application-title-row"><div><h3>{application.applicant_profile?.display_name || application.applicant_email}</h3><p>{application.role_name} · {application.project_title}</p></div><span className={`application-status status-${application.status}`}>{application.status}</span></div>
                      {application.applicant_profile?.skills && <p className="profile-skills">{application.applicant_profile.skills}</p>}
                      {application.applicant_profile?.bio && <p className="profile-bio">{application.applicant_profile.bio}</p>}
                      {application.applicant_profile?.portfolio_url && <a className="profile-link" href={application.applicant_profile.portfolio_url} target="_blank" rel="noreferrer">View portfolio ↗</a>}
                      <p className="application-pitch">{application.pitch_message}</p>
                      <span className="application-date">Applied {application.applied_at ? new Date(application.applied_at).toLocaleDateString() : "recently"}</span>
                    </div>
                    {application.status === "pending" && <div className="application-actions"><button className="decline-button" type="button" disabled={reviewingApplicationId === application.id} onClick={() => reviewApplication(application, "declined")}>Decline</button><button className="primary-button" type="button" disabled={reviewingApplicationId === application.id} onClick={() => reviewApplication(application, "accepted")}>{reviewingApplicationId === application.id ? "Saving…" : "Accept"}</button></div>}
                  </article>
                ))}
              </div>
            )}
            </>}
            {applicationMode === "sent" && <>
              <div className="dashboard-project-tabs" role="group" aria-label="Filter your applications by status">
                {["all", "pending", "accepted", "declined"].map((status) => <button key={status} type="button" aria-pressed={myApplicationStatusFilter === status} className={`filter-chip ${myApplicationStatusFilter === status ? "selected" : ""}`} onClick={() => setMyApplicationStatusFilter(status)}>{status === "all" ? "All statuses" : status[0].toUpperCase() + status.slice(1)}</button>)}
              </div>
              <div className="applications-list-heading"><h2>Your applications</h2><span>{myApplications.filter((item) => item.status === "pending").length} awaiting a response</span></div>
              {myApplicationsLoading && <div className="state-panel"><span className="loading-dot" /> Loading your applications…</div>}
              {!myApplicationsLoading && myApplicationsError && <div className="state-panel error-panel"><strong>Couldn’t load your applications</strong><p>{myApplicationsError}</p><button className="outline-button" type="button" onClick={openApplications}>Try again</button></div>}
              {!myApplicationsLoading && !myApplicationsError && myApplications.length === 0 && <div className="state-panel"><strong>No applications yet</strong><p>When you apply to join a project, you can follow its status here.</p><button className="primary-button" type="button" onClick={() => setActiveView("explore")}>Explore projects <span aria-hidden="true">→</span></button></div>}
              {!myApplicationsLoading && !myApplicationsError && myApplications.length > 0 && myApplications.filter((item) => myApplicationStatusFilter === "all" || item.status === myApplicationStatusFilter).length === 0 && <div className="state-panel"><strong>No {myApplicationStatusFilter} applications</strong><p>Choose another status to see your applications.</p></div>}
              {!myApplicationsLoading && !myApplicationsError && myApplications.length > 0 && (
                <div className="applications-list">
                  {myApplications.filter((item) => myApplicationStatusFilter === "all" || item.status === myApplicationStatusFilter).map((application) => (
                    <article className="application-card sent-application-card" key={application.id}>
                      <div className="applicant-avatar">{(application.project_title || "P").slice(0, 1).toUpperCase()}</div>
                      <div className="application-copy">
                        <div className="application-title-row"><div><h3>{application.project_title}</h3><p>Applied for {application.role_name}</p></div><span className={`application-status status-${application.status}`}>{application.status}</span></div>
                        <p className="application-pitch">{application.pitch_message}</p>
                        <span className="application-date">Applied {application.applied_at ? new Date(application.applied_at).toLocaleDateString() : "recently"}{application.reviewed_at && ` · Reviewed ${new Date(application.reviewed_at).toLocaleDateString()}`}</span>
                      </div>
                      <div className="sent-application-actions">
                        <button className="project-open-button" type="button" onClick={() => openProjectDetails({ id: application.project_id, title: application.project_title, status: application.project_status, is_active: application.project_is_active })}>View project <span aria-hidden="true">→</span></button>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </>}
          </section>
        ) : (
          <section className="applications-page" aria-live="polite">
            <button className="back-link" type="button" onClick={() => setActiveView("explore")}>← Back to Explore</button>
            <div className="applications-heading"><p className="eyebrow">YOUR WORKSPACE</p><h1>My Projects</h1><p>Projects you started and teams you’ve joined.</p></div>
            {myProjectsLoading && <div className="state-panel"><span className="loading-dot" /> Loading your projects…</div>}
            {!myProjectsLoading && myProjectsError && <div className="state-panel error-panel"><strong>Couldn’t load your projects</strong><p>{myProjectsError}</p><button className="outline-button" type="button" onClick={() => setActiveView("explore")}>Back to Explore</button></div>}
            {!myProjectsLoading && !myProjectsError && myProjects.length === 0 && <div className="state-panel"><strong>No projects yet</strong><p>Create a project or join a team to see it here.</p><button className="primary-button" type="button" onClick={() => { setActiveView("explore"); setCreateOpen(true); }}>＋ Create a project</button></div>}
            {!myProjectsLoading && !myProjectsError && myProjects.length > 0 && (
              <div className="project-grid">
                {myProjects.map((project) => {
                  const openRoles = (project.project_roles || []).reduce((total, role) => total + roleOpenings(role), 0);
                  return <article className="project-card" key={project.id}>
                    <div className="project-card-top"><span className="project-type"><span className="type-dot" /> {project.is_owner ? "CREATOR" : "TEAM MEMBER"}</span><span className={`project-state-badge state-${project.status || (project.is_active ? "open" : "closed")}`}>{project.status || (project.is_active ? "open" : "closed")}</span></div>
                    <div className="project-card-copy"><h3>{project.title}</h3><p>{project.description}</p></div>
                    <div className="my-project-meta"><span>{project.members_count} {project.members_count === 1 ? "team member" : "team members"}</span><span>{openRoles} open {openRoles === 1 ? "role" : "roles"}</span></div>
                    {!project.is_owner && project.my_roles.length > 0 && <p className="my-project-role">Your role: {project.my_roles.join(", ")}</p>}
                    <div className="my-project-actions"><button className="project-open-button" type="button" onClick={() => openProjectDetails(project)}>View project <span aria-hidden="true">→</span></button>{project.is_owner && <><button className="project-open-button review-project-button" type="button" onClick={openApplications}>Review applications</button><div className="project-lifecycle-actions">{project.status !== "open" && project.status !== "completed" && <button className="outline-button" type="button" disabled={changingProjectStatus} onClick={() => changeProjectStatus(project, "open")}>Reopen</button>}{project.status === "open" && <button className="outline-button" type="button" disabled={changingProjectStatus} onClick={() => changeProjectStatus(project, "closed")}>Close project</button>}{project.status !== "completed" && <button className="complete-button" type="button" disabled={changingProjectStatus} onClick={() => changeProjectStatus(project, "completed")}>Mark completed</button>}</div></>}</div>
                  </article>;
                })}
              </div>
            )}
          </section>
        )}
        <footer className="page-footer"><span>COLLABCRAFT</span><span>A little spark. Something great together.</span></footer>
      </main>

      {authOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setAuthOpen(false); }}>
          <section className="auth-modal" role="dialog" aria-modal="true" aria-labelledby="auth-title">
            <button className="modal-close" type="button" aria-label="Close authentication" onClick={() => setAuthOpen(false)}>×</button>
            <p className="eyebrow">{authMode === "signin" ? "WELCOME BACK" : "JOIN THE COMMUNITY"}</p>
            <h2 id="auth-title">{authMode === "signin" ? "Sign in to CollabCraft" : "Create your account"}</h2>
            <p className="modal-description">{authMode === "signin" ? "Pick up where your next great project begins." : "Find a team, share an idea, and build something together."}</p>
            <form className="auth-form" onSubmit={authMode === "signin" ? handleSignIn : handleSignUp}>
              <label>Email<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required /></label>
              <label>Password<input type="password" minLength="8" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={authMode === "signin" ? "current-password" : "new-password"} required /></label>
              {authMessage && <p className="form-message" role="alert">{authMessage}</p>}
              <button className="primary-button full-button" type="submit" disabled={signingIn || signingUp}>
                {authMode === "signin" ? (signingIn ? "Signing in…" : "Sign in") : (signingUp ? "Creating account…" : "Create account")}
              </button>
            </form>
            <p className="auth-switch">{authMode === "signin" ? "New to CollabCraft?" : "Already have an account?"}<button type="button" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthMessage(""); }}>{authMode === "signin" ? "Create an account" : "Sign in"}</button></p>
          </section>
        </div>
      )}

      {selectedProject && (
        <div className="modal-backdrop project-details-backdrop" ref={projectDetailsBackdropRef} role="presentation">
          <section className="project-modal" role="dialog" aria-modal="true" aria-labelledby="project-title">
            <div className="project-detail-toolbar">
              <div className="project-detail-toolbar-actions">
                <button className="back-link project-back" type="button" onClick={closeProjectDetails}>← Back to Projects</button>
                {selectedProject.can_manage_project && <button className="outline-button project-edit-trigger" type="button" onClick={() => projectEditOpen ? setProjectEditOpen(false) : beginProjectEdit(selectedProject)}>{projectEditOpen ? "Cancel Editing" : "Edit Project Details"}</button>}
              </div>
              <button className="modal-close" type="button" aria-label="Close project details" onClick={closeProjectDetails}>×</button>
            </div>
            {projectEditOpen && selectedProject.can_manage_project && (
              <section className="project-edit-panel" aria-labelledby="edit-project-title">
                <div className="workspace-heading"><div><p className="eyebrow">CREATOR WORKSPACE</p><h3 id="edit-project-title">Edit project details</h3><p>Update the idea and the roles your team still needs.</p></div></div>
                <form className="project-edit-form" onSubmit={handleProjectEdit}>
                  <label>Project title<input maxLength="120" value={projectEditForm.title} onChange={(event) => setProjectEditForm({ ...projectEditForm, title: event.target.value.toUpperCase() })} required /></label>
                  <label>Project description<textarea maxLength="2000" rows="4" value={projectEditForm.description} onChange={(event) => setProjectEditForm({ ...projectEditForm, description: event.target.value.toUpperCase() })} required /></label>
                  <label>Tech stack<input value={projectEditForm.tech_stack} onChange={(event) => setProjectEditForm({ ...projectEditForm, tech_stack: event.target.value.toUpperCase() })} placeholder="React, Flask, Supabase" /></label>
                  <label>GitHub repository <span className="profile-optional">PUBLIC REPO</span><input type="url" maxLength="300" value={projectEditForm.github_url} onChange={(event) => setProjectEditForm({ ...projectEditForm, github_url: event.target.value })} placeholder="https://github.com/owner/repository" /></label>
                  <div className="create-roles">
                    <div className="create-roles-heading"><strong>Team roles</strong><span>Keep openings at or above the number of people already accepted.</span></div>
                    {projectEditForm.roles.map((role, index) => (
                      <div className="role-input-row" key={role.id ?? `new-${index}`}>
                        <label className="sr-only" htmlFor={`edit-role-name-${index}`}>Role name</label>
                        <input id={`edit-role-name-${index}`} maxLength="80" value={role.role_name} onChange={(event) => setProjectEditForm({ ...projectEditForm, roles: projectEditForm.roles.map((item, roleIndex) => roleIndex === index ? { ...item, role_name: event.target.value.toUpperCase() } : item) })} placeholder="Role name" required />
                        <label className="sr-only" htmlFor={`edit-role-slots-${index}`}>Openings</label>
                        <input id={`edit-role-slots-${index}`} type="number" min="1" max="20" value={role.slots_total} onChange={(event) => setProjectEditForm({ ...projectEditForm, roles: projectEditForm.roles.map((item, roleIndex) => roleIndex === index ? { ...item, slots_total: Number(event.target.value) } : item) })} required />
                        {projectEditForm.roles.length > 1 && <button className="remove-role" type="button" aria-label={`Remove ${role.role_name || "role"}`} onClick={() => setProjectEditForm({ ...projectEditForm, roles: projectEditForm.roles.filter((_, roleIndex) => roleIndex !== index) })}>−</button>}
                      </div>
                    ))}
                    <button className="add-role" type="button" onClick={() => setProjectEditForm({ ...projectEditForm, roles: [...projectEditForm.roles, { role_name: "", slots_total: 1 }] })}>＋ Add another role</button>
                  </div>
                  {projectEditMessage && <p className="form-message" role="alert">{projectEditMessage}</p>}
                  <div className="project-edit-actions"><button className="outline-button" type="button" disabled={savingProjectEdit} onClick={() => setProjectEditOpen(false)}>Cancel</button><button className="primary-button" type="submit" disabled={savingProjectEdit}>{savingProjectEdit ? "Saving changes…" : "Save changes"}</button></div>
                </form>
              </section>
            )}
            <div className="project-detail-heading">
              <div><span className="project-type"><span className="type-dot" /> SIDE PROJECT</span><h2 id="project-title">{selectedProject.title}</h2><p>{selectedProject.description}</p></div>
              <span className={`project-state-badge state-${selectedProject.status || (selectedProject.is_active === false ? "closed" : "open")}`}>{selectedProject.status || (selectedProject.is_active === false ? "closed" : "open")}</span>
            </div>
            <div className="tech-tags project-detail-tags">{(selectedProject.tech_stack || []).map((tech) => <span className="tech-tag" key={tech}>{tech}</span>)}</div>
            {selectedProject.github_url && <GithubRepoPreview key={selectedProject.github_url} repoUrl={selectedProject.github_url} />}
            <div className="project-detail-grid">
              <div className="project-detail-main">
                <section className="about-project-panel"><h3>About this project</h3><p>{selectedProject.description}</p></section>
                <h3 className="roles-heading">Roles we need</h3>
                {(selectedProject.project_roles || []).map((role) => <article className="detail-role-card" key={role.id}><span className="role-icon" aria-hidden="true">{role.role_name.toLowerCase().includes("design") ? "✳" : "⌘"}</span><div><strong>{role.role_name}</strong><p>Join the team as a {role.role_name.toLowerCase()}.</p></div><span className="role-count">{roleOpenings(role)} {roleOpenings(role) === 1 ? "opening" : "openings"}</span><button className="role-apply-button" type="button" disabled={roleOpenings(role) < 1 || selectedProject.is_active === false} onClick={() => startApplication(selectedProject, role)}>Apply</button></article>)}
              </div>
              <aside className="project-detail-sidebar">
                <section className="creator-panel"><h3>Project creator</h3><div className="creator-summary"><span className="creator-avatar">{(selectedProject.creator_email || "CC").slice(0, 1).toUpperCase()}</span><div><strong>{selectedProject.creator_email || "Project creator"}</strong><p>Building with the community</p></div></div></section>
                <section className="team-section"><h3>Team so far</h3><p className="team-count-line">{selectedProject.members?.length || 0} {selectedProject.members?.length === 1 ? "member" : "members"} · {(selectedProject.project_roles || []).reduce((total, role) => total + roleOpenings(role), 0)} roles open</p>
                  {projectDetailsLoading && <p className="team-empty">Loading team members…</p>}
                  {!projectDetailsLoading && projectDetailsError && <p className="team-empty team-error">{projectDetailsError}</p>}
                  {!projectDetailsLoading && !projectDetailsError && selectedProject.members?.length > 0 && <div className="team-member-list">{selectedProject.members.map((member) => { const memberName = member.display_name || member.email || member.label; return <article className="team-member" key={member.id}><span className="team-avatar">{memberName.slice(0, 1).toUpperCase()}</span><span className="team-member-info"><span className="team-member-name">{memberName}</span><span className="team-member-role">{member.role_name}</span>{member.skills && <span className="profile-skills">{member.skills}</span>}{member.bio && <span className="profile-bio">{member.bio}</span>}{member.portfolio_url && <a className="profile-link" href={member.portfolio_url} target="_blank" rel="noreferrer">View portfolio ↗</a>}</span></article>; })}</div>}
                  {!projectDetailsLoading && !projectDetailsError && (!selectedProject.members || selectedProject.members.length === 0) && <p className="team-empty">No teammates yet.</p>}
                </section>
                {selectedProject.can_manage_project && <section className="creator-project-controls"><h3>Project status</h3><p>This status controls whether new applications are accepted.</p><div className="project-lifecycle-actions">{selectedProject.status !== "open" && selectedProject.status !== "completed" && <button className="outline-button" type="button" disabled={changingProjectStatus} onClick={() => changeProjectStatus(selectedProject, "open")}>Reopen project</button>}{selectedProject.status === "open" && <button className="outline-button" type="button" disabled={changingProjectStatus} onClick={() => changeProjectStatus(selectedProject, "closed")}>Close project</button>}{selectedProject.status !== "completed" && <button className="complete-button" type="button" disabled={changingProjectStatus} onClick={() => changeProjectStatus(selectedProject, "completed")}>Mark completed</button>}</div></section>}
              </aside>
            </div>
            {selectedProject.can_view_project_area && <section className="project-workspace">
              <div className="workspace-heading"><div><p className="eyebrow">SHARED WITH APPLICANTS AND TEAM</p><h3>Project work area</h3><p>Creator-uploaded files and progress notes for this project.</p></div>{workspace.access === "creator" && <span className="creator-only-badge">CREATOR MANAGED</span>}</div>
              {workspaceError && <p className="form-message workspace-message" role="alert">{workspaceError}</p>}
              {workspaceLoading && <div className="state-panel workspace-loading"><span className="loading-dot" /> Loading work area…</div>}
              {!workspaceLoading && ["creator", "member"].includes(workspace.access) && !workspace.task_board_available && <div className="workspace-empty task-board-setup">The task board needs its database setup before it can be used. Run <strong>Backend/collabcraft_tasks_migration.sql</strong> in the Supabase SQL Editor.</div>}
              {!workspaceLoading && ["creator", "member"].includes(workspace.access) && workspace.task_board_available && <section className="task-board" aria-label="Project task board">
                <div className="task-board-heading"><div><p className="eyebrow">PLAN THE NEXT STEPS</p><h4>Team task board</h4><p>Add work, assign a teammate, and track progress together.</p></div><span>{workspace.tasks.length} {workspace.tasks.length === 1 ? "task" : "tasks"}</span></div>
                <form className="task-create-form" onSubmit={handleCreateTask}>
                  <label>Task title<input maxLength="120" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value.toUpperCase())} placeholder="WHAT NEEDS TO GET DONE?" required /></label>
                  <label>Details<textarea maxLength="1000" rows="2" value={taskDescription} onChange={(event) => setTaskDescription(event.target.value.toUpperCase())} placeholder="ADD A FEW DETAILS (OPTIONAL)" /></label>
                  <label>Assign to<select value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)}><option value="">Unassigned</option>{workspace.team_members.map((member) => <option key={member.id} value={member.id}>{member.name} · {member.role_name}</option>)}</select></label>
                  <button className="primary-button" type="submit" disabled={savingTask || !taskTitle.trim()}>{savingTask ? "Adding task…" : "＋ Add task"}</button>
                </form>
                <div className="task-columns">
                  {[{ key: "todo", label: "To do" }, { key: "in_progress", label: "In progress" }, { key: "done", label: "Done" }].map((column) => {
                    const columnTasks = workspace.tasks.filter((task) => task.status === column.key);
                    return <section className={`task-column task-column-${column.key}`} key={column.key} aria-label={`${column.label} tasks`}>
                      <div className="task-column-heading"><h5>{column.label}</h5><span>{columnTasks.length}</span></div>
                      {columnTasks.length === 0 && <p className="task-column-empty">No tasks here yet.</p>}
                      {columnTasks.map((task) => <article className="task-card" key={task.id}>
                        <h6>{task.title}</h6>
                        {task.description && <p>{task.description}</p>}
                        <label>Status<select value={task.status} disabled={updatingTaskId === task.id} onChange={(event) => handleUpdateTask(task.id, { status: event.target.value })}><option value="todo">To do</option><option value="in_progress">In progress</option><option value="done">Done</option></select></label>
                        <label>Assignee<select value={task.assigned_to || ""} disabled={updatingTaskId === task.id} onChange={(event) => handleUpdateTask(task.id, { assigned_to: event.target.value || null })}><option value="">Unassigned</option>{workspace.team_members.map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
                      </article>)}
                    </section>;
                  })}
                </div>
              </section>}
              {!workspaceLoading && ["creator", "member"].includes(workspace.access) && <section className="project-chat" aria-label="Private team chat">
                <div className="chat-heading"><div><p className="eyebrow">TEAM CONVERSATION</p><h4>Project chat</h4><p>Private to the creator and accepted teammates · refreshes automatically</p></div><span className="chat-private-badge">PRIVATE</span></div>
                {chatError && <p className="form-message chat-error" role="alert">{chatError}</p>}
                <div className="chat-message-list" ref={projectChatListRef} onScroll={(event) => { const element = event.currentTarget; chatShouldStickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48; }} role="log" aria-live="polite" aria-relevant="additions">
                  {chatMessages.length === 0 && <p className="chat-empty">No messages yet. Start the team conversation.</p>}
                  {chatMessages.map((message) => {
                    const isOwnMessage = String(message.author_id) === String(session?.user?.id);
                    return <article className={`chat-message ${isOwnMessage ? "chat-message-own" : ""}`} key={message.id}>
                      <div className="chat-message-meta"><strong>{isOwnMessage ? "You" : message.author_name || "Team member"}</strong><time>{message.created_at ? new Date(message.created_at).toLocaleString() : "Just now"}</time></div>
                      <p>{message.body}</p>
                    </article>;
                  })}
                </div>
                <form className="chat-compose" onSubmit={handleSendChatMessage}>
                  <label className="sr-only" htmlFor="project-chat-draft">Write a team message</label>
                  <textarea id="project-chat-draft" rows="2" maxLength="2000" value={chatDraft} onChange={(event) => setChatDraft(event.target.value.toUpperCase())} placeholder="WRITE A MESSAGE TO YOUR TEAM…" />
                  <div className="chat-compose-footer"><span>{chatDraft.length}/2000</span><button className="primary-button" type="submit" disabled={sendingChat || !chatDraft.trim()}>{sendingChat ? "Sending…" : "Send message"}<span aria-hidden="true">↗</span></button></div>
                </form>
              </section>}
              {!workspaceLoading && workspace.access === "creator" && <form className="work-upload-form" onSubmit={handleAddWorkItem}>
                <div className="workspace-form-heading"><strong>Add project work</strong><span>Only you can add or edit these items. Files up to 10 MB.</span></div>
                <label>Title<input maxLength="120" value={workTitle} onChange={(event) => setWorkTitle(event.target.value.toUpperCase())} placeholder="e.g. First mobile prototype" required /></label>
                <label>Description<textarea maxLength="2000" rows="3" value={workDescription} onChange={(event) => setWorkDescription(event.target.value.toUpperCase())} placeholder="Share what this work item contains or its current progress." /></label>
                <label className="file-picker-label">Attach a file<input type="file" onChange={(event) => setWorkFile(event.target.files?.[0] || null)} />{workFile && <span className="selected-file-name">{workFile.name} · {(workFile.size / (1024 * 1024)).toFixed(1)} MB</span>}</label>
                <button className="primary-button" type="submit" disabled={savingWork || !workTitle.trim() || (workFile && workFile.size > 10 * 1024 * 1024)}>{savingWork ? "Uploading…" : "＋ Add to work area"}</button>
              </form>}
              {!workspaceLoading && workspace.access && <div className="work-item-list">
                {workspace.work_items.length === 0 && <div className="workspace-empty">No work shared yet. The creator can add files and progress notes here.</div>}
                {workspace.work_items.map((item) => <article className="work-item-card" key={item.id}>
                  {editingWorkId === item.id ? <form className="work-edit-form" onSubmit={(event) => handleSaveWorkEdit(event, item.id)}><label>Title<input maxLength="120" value={editingWorkForm.title} onChange={(event) => setEditingWorkForm({ ...editingWorkForm, title: event.target.value.toUpperCase() })} required /></label><label>Description<textarea maxLength="2000" rows="3" value={editingWorkForm.description} onChange={(event) => setEditingWorkForm({ ...editingWorkForm, description: event.target.value.toUpperCase() })} /></label><button className="primary-button" type="submit" disabled={savingWork}>{savingWork ? "Saving…" : "Save changes"}</button><button className="outline-button" type="button" onClick={() => setEditingWorkId(null)}>Cancel</button></form> : <><div className="work-item-top"><div><h4>{item.title}</h4><span>Added {new Date(item.created_at).toLocaleDateString()}</span></div>{workspace.access === "creator" && <button className="outline-button" type="button" onClick={() => { setEditingWorkId(item.id); setEditingWorkForm({ title: item.title, description: item.description || "" }); }}>Edit</button>}</div><p>{item.description}</p>{item.file_name && <a className="work-file-link" href={item.file_url || undefined} target="_blank" rel="noreferrer">↗ {item.file_name}</a>}</>}
                </article>)}
              </div>}
              {!workspaceLoading && !workspace.access && <p className="workspace-empty">Sign in and apply to this project to view its shared work area.</p>}
            </section>}
            {selectedProject.can_view_project_area && <section className="project-feedback-section">
              <div className="workspace-heading"><div><p className="eyebrow">TEAM CONVERSATION</p><h3>Comments & suggestions</h3><p>Share feedback with the project creator and applicants.</p></div></div>
              {workspace.access && <form className="feedback-form" onSubmit={handleFeedback}><select aria-label="Feedback type" value={feedbackKind} onChange={(event) => setFeedbackKind(event.target.value)}><option value="comment">Comment</option><option value="suggestion">Suggestion</option></select><textarea maxLength="2000" rows="3" value={feedbackBody} onChange={(event) => setFeedbackBody(event.target.value.toUpperCase())} placeholder="Write a comment or suggest an idea…" required /><div className="feedback-submit-row"><span>{feedbackBody.length}/2000</span><button className="primary-button" type="submit" disabled={savingFeedback || !feedbackBody.trim()}>{savingFeedback ? "Posting…" : `Post ${feedbackKind}`}</button></div></form>}
              <div className="feedback-list">{workspace.feedback.map((entry) => <article className="feedback-card" key={entry.id}><div className="feedback-meta"><strong>{entry.author_email}</strong><span className={`feedback-kind kind-${entry.kind}`}>{entry.kind}</span><time>{new Date(entry.created_at).toLocaleString()}</time></div><p>{entry.body}</p></article>)}{!workspaceLoading && workspace.access && workspace.feedback.length === 0 && <p className="workspace-empty">No comments yet. Start the conversation.</p>}</div>
            </section>}
          </section>
        </div>
      )}
      {createOpen && (
        <div className="modal-backdrop create-backdrop" role="presentation">
          <section className="create-modal" role="dialog" aria-modal="true" aria-labelledby="create-title">
            <button className="modal-close" type="button" aria-label="Close project form" onClick={() => !publishing && setCreateOpen(false)}>×</button>
            <button className="back-link create-back" type="button" onClick={() => !publishing && setCreateOpen(false)}>← Back to Projects</button>
            <p className="eyebrow">CREATOR WORKSPACE</p>
            <h2 id="create-title">Share your project idea</h2>
            <p className="modal-description">Add the basics now. You can refine the details later.</p>
            <form className="create-form" onSubmit={handleCreateProject}>
              <div className="create-fields">
                <label>Project title<input maxLength="120" value={projectForm.title} onChange={(event) => setProjectForm({ ...projectForm, title: event.target.value.toUpperCase() })} placeholder="e.g. Plant care, made simple" required /></label>
                <label>Project description<textarea maxLength="2000" rows="4" value={projectForm.description} onChange={(event) => setProjectForm({ ...projectForm, description: event.target.value.toUpperCase() })} placeholder="What are you building, and who is it for?" required /></label>
                <label>Tech stack<input value={projectForm.tech_stack} onChange={(event) => setProjectForm({ ...projectForm, tech_stack: event.target.value.toUpperCase() })} placeholder="Add tools or skills, separated by commas" /></label>
                <label>GitHub repository <span className="profile-optional">PUBLIC REPO · OPTIONAL</span><input type="url" maxLength="300" value={projectForm.github_url} onChange={(event) => setProjectForm({ ...projectForm, github_url: event.target.value })} placeholder="https://github.com/owner/repository" /></label>
                <div className="create-roles">
                  <div className="create-roles-heading"><strong>Team roles</strong><span>List the roles you need and number of openings.</span></div>
                  {projectForm.roles.map((role, index) => (
                    <div className="role-input-row" key={index}>
                      <label className="sr-only" htmlFor={`role-name-${index}`}>Role name</label>
                      <input id={`role-name-${index}`} maxLength="80" value={role.role_name} onChange={(event) => updateRole(index, "role_name", event.target.value)} placeholder="Role name" required />
                      <label className="sr-only" htmlFor={`role-slots-${index}`}>Openings</label>
                      <input id={`role-slots-${index}`} type="number" min="1" max="20" value={role.slots_total} onChange={(event) => updateRole(index, "slots_total", event.target.value)} required />
                      {projectForm.roles.length > 1 && <button className="remove-role" type="button" aria-label="Remove role" onClick={() => setProjectForm({ ...projectForm, roles: projectForm.roles.filter((_, roleIndex) => roleIndex !== index) })}>−</button>}
                    </div>
                  ))}
                  <button className="add-role" type="button" onClick={() => setProjectForm({ ...projectForm, roles: [...projectForm.roles, { role_name: "", slots_total: 1 }] })}>＋ Add another role</button>
                </div>
                {projectMessage && <p className="form-message" role="alert">{projectMessage}</p>}
              </div>
              <aside className="create-preview">
                <div className="create-preview-heading"><strong>Your project preview</strong><span>PREVIEW</span></div>
                <p className="eyebrow">PROJECT</p>
                <h3>{projectForm.title || "Project title"}</h3>
                <p className="create-preview-description">{projectForm.description || "Short description preview…"}</p>
                <div className="tech-tags">{projectForm.tech_stack.split(",").map((tech) => tech.trim()).filter(Boolean).map((tech) => <span className="tech-tag" key={tech}>{tech}</span>)}</div>
                <div className="preview-role-list">
                  <span className="eyebrow">TEAM ROLES</span>
                  {projectForm.roles.some((role) => role.role_name.trim()) ? projectForm.roles.filter((role) => role.role_name.trim()).map((role, index) => <div className="preview-role" key={`${role.role_name}-${index}`}><span>{role.role_name}</span><span>{role.slots_total} {Number(role.slots_total) === 1 ? "opening" : "openings"}</span></div>) : <p>Roles will appear here</p>}
                </div>
                <span className="preview-open-status">• {projectForm.roles.reduce((total, role) => total + (Number(role.slots_total) || 0), 0)} openings available</span>
              </aside>
              <button className="primary-button full-button create-submit" type="submit" disabled={publishing}>{publishing ? "Publishing…" : "Publish project"}<span aria-hidden="true">↗</span></button>
              {!session && <p className="create-sign-in-hint create-submit">You’ll need to sign in before publishing.</p>}
            </form>
          </section>
        </div>
      )}
      {applyOpen && applyTarget && (
        <div className="modal-backdrop apply-backdrop" role="presentation">
          <section className="apply-modal" role="dialog" aria-modal="true" aria-labelledby="apply-title">
            <button className="modal-close" type="button" aria-label="Close application form" onClick={() => !submittingApplication && setApplyOpen(false)}>×</button>
            <button className="back-link apply-back" type="button" onClick={() => { setApplyOpen(false); setSelectedProject(applyTarget.project); }}>← Back to project</button>
            <p className="eyebrow">COLLABCRAFT / APPLY</p>
            <h2 id="apply-title">Apply to join the team</h2>
            <p className="modal-description">Tell the creator what you can bring to this project.</p>
            <form className="apply-form" onSubmit={handleApply}>
              <aside className="apply-project-preview">
                <p className="eyebrow">PROJECT</p>
                <h3>{applyTarget.project.title}</h3>
                <p>{applyTarget.project.description}</p>
                <div className="tech-tags">{(applyTarget.project.tech_stack || []).map((tech) => <span className="tech-tag" key={tech}>{tech}</span>)}</div>
              </aside>
              <div className="apply-fields">
                <label>Role you’re applying for<select value={applyTarget.role.id} onChange={(event) => { const role = (applyTarget.project.project_roles || []).find((item) => String(item.id) === event.target.value); if (role) setApplyTarget({ ...applyTarget, role }); }}>{(applyTarget.project.project_roles || []).filter((role) => roleOpenings(role) > 0).map((role) => <option key={role.id} value={role.id}>{role.role_name}</option>)}</select></label>
                <p className="opening-hint">• {roleOpenings(applyTarget.role)} {roleOpenings(applyTarget.role) === 1 ? "opening" : "openings"} available</p>
                <div className="application-intro-heading"><h3>Your introduction</h3><p>Share relevant skills or experience with the creator.</p></div>
            <label>Application note<textarea className="application-note" minLength="10" maxLength="2000" rows="6" value={pitchMessage} onChange={(event) => setPitchMessage(event.target.value.toUpperCase())} placeholder="Hi! Share why you’re interested and what you can contribute…" required /></label>
                <div className="application-note-footer"><span>Keep it short and specific (10–2,000 characters).</span><span>{pitchMessage.length}/2000</span></div>
                {applicationMessage && <p className="form-message" role="alert">{applicationMessage}</p>}
                <button className="primary-button full-button" type="submit" disabled={submittingApplication || pitchMessage.trim().length < 10}>{submittingApplication ? "Sending…" : "Send application"}<span aria-hidden="true">↗</span></button>
              </div>
            </form>
          </section>
        </div>
      )}
      {notice && <div className="toast" role="status">{notice}</div>}
    </div>
  );
}



