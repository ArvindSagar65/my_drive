import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  GithubAuthProvider,
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from "firebase/auth";
import { auth, githubProvider, googleProvider } from "./firebase";
import {
  getApiUrl,
  authorizedFetch,
  fetchAuthorizedBlob,
  saveUserProfile,
} from "./api";
import { uploadMany } from "./upload";
import "./App.css";

function formatFileSize(bytes) {
  if (!bytes) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function formatDate(isoString) {
  const date = new Date(isoString || Date.now());
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function fileExtension(filename = "") {
  return filename.split(".").pop().toLowerCase();
}

function getFileIcon(filename) {
  const ext = fileExtension(filename);
  const iconMap = {
    pdf: "picture_as_pdf",
    jpg: "image",
    jpeg: "image",
    png: "image",
    gif: "image",
    webp: "image",
    bmp: "image",
    svg: "image",
    mp4: "movie",
    webm: "movie",
    mkv: "movie",
    mov: "movie",
    avi: "movie",
    flv: "movie",
    wmv: "movie",
    doc: "description",
    docx: "description",
    xls: "table_chart",
    xlsx: "table_chart",
    zip: "inventory_2",
    rar: "inventory_2",
    "7z": "inventory_2",
  };
  return iconMap[ext] || "insert_drive_file";
}

function isImage(filename) {
  return ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"].includes(
    fileExtension(filename)
  );
}

function isVideo(filename) {
  return ["mp4", "webm", "mkv", "mov", "avi", "flv", "wmv"].includes(
    fileExtension(filename)
  );
}

function isText(filename) {
  return [
    "txt",
    "md",
    "json",
    "xml",
    "html",
    "css",
    "js",
    "py",
    "java",
    "cpp",
    "c",
    "h",
    "log",
  ].includes(fileExtension(filename));
}

function isPdf(filename) {
  return filename.toLowerCase().endsWith(".pdf");
}

function canPreview(filename) {
  return isImage(filename) || isVideo(filename) || isPdf(filename) || isText(filename);
}

function providerFromUser(user) {
  const providerId = user?.providerData?.[0]?.providerId || "";
  if (providerId.includes("github")) return "github";
  if (providerId.includes("google")) return "google";
  return providerId || "unknown";
}

function AuthMedia({ path, token, alt, className, kind = "img" }) {
  const [src, setSrc] = useState("");

  useEffect(() => {
    let objectUrl;
    let cancelled = false;

    (async () => {
      try {
        const blob = await fetchAuthorizedBlob(path, token);
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      } catch {
        if (!cancelled) setSrc("");
      }
    })();

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, token]);

  if (!src) {
    return (
      <div className={`${className} flex items-center justify-center bg-slate-100`}>
        <span className="material-symbols-outlined text-slate-300">image</span>
      </div>
    );
  }

  if (kind === "video") {
    return <video src={src} className={className} controls />;
  }
  if (kind === "iframe") {
    return <iframe title={alt} src={src} className={className} />;
  }
  return <img src={src} alt={alt} className={className} />;
}

function FileCard({ file, token, onPreview, onDownload, onStar, onDelete }) {
  const fileName = file.originalName || file.name || "Untitled";
  const showThumb = (isImage(fileName) || isVideo(fileName)) && file.thumbnailPath;

  return (
    <div
      className="tonal-layer rounded-xl bg-white p-4 flex flex-col gap-3 transition-all group cursor-pointer hover:shadow-md border border-slate-200"
      onDoubleClick={() => {
        if (canPreview(fileName)) onPreview(file);
      }}
    >
      {showThumb && (
        <div
          className="w-full h-32 bg-slate-100 rounded-lg overflow-hidden relative"
          onDoubleClick={(e) => {
            e.stopPropagation();
            onPreview(file);
          }}
        >
          <AuthMedia
            path={`/thumbnail/${file.id}`}
            token={token}
            alt={fileName}
            className="w-full h-full object-cover hover:scale-105 transition-transform"
          />
          {isVideo(fileName) && (
            <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-30 pointer-events-none">
              <span className="material-symbols-outlined text-4xl text-white">
                play_circle
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex items-start justify-between">
        <div className="p-2 bg-blue-50 text-blue-600 rounded-lg">
          <span className="material-symbols-outlined text-xl">
            {getFileIcon(fileName)}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          {canPreview(fileName) && (
            <button
              type="button"
              onClick={() => onPreview(file)}
              className="p-1 text-slate-400 hover:text-blue-600"
              title="Preview"
            >
              <span className="material-symbols-outlined text-lg">visibility</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onDownload(file)}
            className="p-1 text-slate-400 hover:text-blue-600"
            title="Download"
          >
            <span className="material-symbols-outlined text-lg">download</span>
          </button>
          <button
            type="button"
            onClick={() => onStar(file)}
            className="p-1 text-slate-400 hover:text-blue-600"
            title="Star"
          >
            <span
              className={`material-symbols-outlined text-lg ${
                file.isStarred ? "filled text-amber-500" : ""
              }`}
            >
              grade
            </span>
          </button>
          <button
            type="button"
            onClick={() => onDelete(file)}
            className="p-1 text-slate-400 hover:text-rose-600"
            title="Delete"
          >
            <span className="material-symbols-outlined text-lg">delete</span>
          </button>
        </div>
      </div>

      <div className="space-y-1 overflow-hidden">
        <h4 className="text-sm font-semibold truncate text-slate-800" title={fileName}>
          {fileName}
        </h4>
        <div className="flex items-center gap-2 text-xs font-mono text-slate-400">
          <span>{formatFileSize(file.fileSize || file.size)}</span>
          <span>•</span>
          <span>{formatDate(file.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState(null);
  const [token, setToken] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [section, setSection] = useState("all-files");
  const [files, setFiles] = useState([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [quotaGB, setQuotaGB] = useState("5");
  const [quotaStatus, setQuotaStatus] = useState(null);
  const [savingQuota, setSavingQuota] = useState(false);
  const [storage, setStorage] = useState({
    percentage: 0,
    usedFormatted: "0 B",
    limitFormatted: "5 GB",
  });
  const [selectedFile, setSelectedFile] = useState(null);
  const [previewText, setPreviewText] = useState("");
  const [uploadJobs, setUploadJobs] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [search, setSearch] = useState("");
  const [chosenName, setChosenName] = useState("Click or drag files to upload");
  const fileInputRef = useRef(null);
  const menuRef = useRef(null);

  const sectionMeta = useMemo(() => {
    if (section === "recent") return { endpoint: "/files/recent", title: "Recent Files" };
    if (section === "starred") return { endpoint: "/files/starred", title: "Starred Files" };
    return { endpoint: "/files", title: "My Files" };
  }, [section]);

  const loadStorage = useCallback(async (idToken) => {
    try {
      const response = await authorizedFetch(`${getApiUrl()}/storage`, idToken);
      if (!response.ok) return;
      const data = await response.json();
      setStorage(data);
      if (data.storageLimitGB) {
        setQuotaGB(String(data.storageLimitGB));
      }
    } catch (err) {
      console.error("Error loading storage:", err);
    }
  }, []);

  const loadFiles = useCallback(
    async (idToken = token) => {
      if (!idToken) return;
      setFilesLoading(true);
      setFilesError("");
      await loadStorage(idToken);

      try {
        const response = await authorizedFetch(
          `${getApiUrl()}${sectionMeta.endpoint}`,
          idToken
        );
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const data = await response.json();
        setFiles(data.files || []);
      } catch (err) {
        console.error("Error loading files:", err);
        setFilesError("Error loading files");
        setFiles([]);
      } finally {
        setFilesLoading(false);
      }
    },
    [loadStorage, sectionMeta.endpoint, token]
  );

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        try {
          const idToken = await currentUser.getIdToken();
          setToken(idToken);
          await saveUserProfile(
            currentUser,
            idToken,
            providerFromUser(currentUser)
          ).catch((err) => console.error("Profile save failed:", err));
        } catch (err) {
          console.error("Failed to get ID token:", err);
          setToken(null);
        }
      } else {
        setToken(null);
        setFiles([]);
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    if (token) loadFiles(token);
  }, [token, section, loadFiles]);

  useEffect(() => {
    const onClick = (event) => {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  const handleSignIn = async (provider, label) => {
    setAuthError("");
    try {
      const result = await signInWithPopup(auth, provider);
      const idToken = await result.user.getIdToken();
      const providerName =
        provider instanceof GithubAuthProvider
          ? "github"
          : provider instanceof GoogleAuthProvider
            ? "google"
            : label;
      await saveUserProfile(result.user, idToken, providerName);
    } catch (error) {
      console.error(`${label} sign-in error:`, error);
      setAuthError(`${label} sign-in failed: ${error.message}`);
    }
  };

  const saveQuota = async (event) => {
    event.preventDefault();
    setSavingQuota(true);
    setQuotaStatus(null);
    try {
      const response = await authorizedFetch(`${getApiUrl()}/user/storage`, token, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storageLimitGB: Number(quotaGB) }),
      });
      const result = await response.json();
      if (!response.ok) {
        throw new Error(result.error || "Failed to update storage limit");
      }
      setQuotaStatus({ ok: true, text: `Bucket limit set to ${result.storageLimitGB} GB` });
      loadStorage(token);
    } catch (error) {
      setQuotaStatus({ ok: false, text: error.message });
    } finally {
      setSavingQuota(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await signOut(auth);
      setMenuOpen(false);
    } catch (error) {
      alert("Logout failed: " + error.message);
    }
  };

  const visibleFiles = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) =>
      (file.originalName || file.name || "").toLowerCase().includes(q)
    );
  }, [files, search]);

  const stageFiles = (list) => {
    const incoming = [...(list || [])];
    if (!incoming.length || !fileInputRef.current) return;
    const dt = new DataTransfer();
    incoming.forEach((file) => dt.items.add(file));
    fileInputRef.current.files = dt.files;
    setChosenName(
      incoming.length === 1
        ? incoming[0].name
        : `${incoming.length} files selected`
    );
  };

  const copyCliToken = async () => {
    try {
      const idToken = await user.getIdToken(true);
      await navigator.clipboard.writeText(idToken);
      alert("CLI token copied. Run: mydrive login --token <paste> --api " + getApiUrl());
    } catch (error) {
      alert("Could not copy token: " + error.message);
    }
  };

  const handleUpload = async (event) => {
    event.preventDefault();
    const selected = [...(fileInputRef.current?.files || [])];
    if (!selected.length) {
      setUploadJobs([{ name: "No files", status: "error", error: "Choose one or more files" }]);
      return;
    }

    setUploading(true);
    setUploadJobs(
      selected.map((file) => ({
        name: file.name,
        progress: 0,
        status: "queued",
      }))
    );

    try {
      await uploadMany(selected, token, (index, job) => {
        setUploadJobs((prev) => {
          const next = [...prev];
          next[index] = { ...next[index], ...job };
          return next;
        });
      });
      if (fileInputRef.current) fileInputRef.current.value = "";
      setChosenName("Click or drag files to upload");
      loadFiles(token);
    } finally {
      setUploading(false);
    }
  };

  const openPreview = async (file) => {
    setSelectedFile(file);
    setPreviewText("");
    const fileName = file.originalName || file.name;
    if (isText(fileName)) {
      try {
        const blob = await fetchAuthorizedBlob(`/preview/${file.id}`, token);
        const text = await blob.text();
        setPreviewText(text.substring(0, 100000));
      } catch {
        setPreviewText("");
      }
    }
  };

  const downloadFile = async (file) => {
    try {
      const blob = await fetchAuthorizedBlob(`/download/${file.id}`, token);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = file.originalName || file.name || "download";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      alert("Download failed: " + error.message);
    }
  };

  const toggleStar = async (file) => {
    try {
      const response = await authorizedFetch(
        `${getApiUrl()}/files/${file.id}/star`,
        token,
        { method: "PATCH" }
      );
      if (!response.ok) throw new Error("Failed to toggle star");
      loadFiles(token);
    } catch (error) {
      alert("Error: " + error.message);
    }
  };

  const deleteFile = async (file) => {
    if (!window.confirm("Delete this file?")) return;
    try {
      const response = await authorizedFetch(
        `${getApiUrl()}/files/${file.id}`,
        token,
        { method: "DELETE" }
      );
      if (!response.ok) throw new Error("Delete failed");
      loadFiles(token);
    } catch (error) {
      alert("Error: " + error.message);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 text-slate-600">
        Loading my_drive...
      </div>
    );
  }

  if (!user) {
    return (
      <div className="fixed inset-0 z-40 flex items-center justify-center bg-gradient-to-br from-blue-100 to-slate-50">
        <div className="max-w-md w-full mx-4 space-y-6">
          <div className="text-center mb-6">
            <h1 className="text-4xl font-bold text-blue-600 mb-2">my_drive</h1>
            <p className="text-base text-slate-600">Self-hosted cloud storage</p>
            <p className="text-sm text-slate-500 mt-2">
              Files stay on this device. Sign in to open your private bucket from any network.
            </p>
          </div>

          <div className="space-y-4 bg-white p-8 rounded-2xl shadow-sm border border-slate-200">
            <button
              type="button"
              onClick={() => handleSignIn(googleProvider, "Google")}
              className="w-full flex items-center justify-center gap-3 bg-white border border-slate-300 px-4 py-3 rounded-lg text-sm font-semibold text-slate-700 hover:bg-slate-50 transition-all active:scale-95 shadow-sm"
            >
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.66-5.17 3.66-9.17z" />
                <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.1-6.72-4.93H1.19v3.15C3.17 21.32 7.21 24 12 24z" />
                <path fill="#FBBC05" d="M5.28 14.27c-.25-.72-.38-1.49-.38-2.27s.13-1.55.38-2.27V6.58H1.19C.43 8.12 0 9.87 0 12s.43 3.88 1.19 5.42l4.09-3.15z" />
                <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.21 0 3.17 2.68 1.19 6.58l4.09 3.15c.95-2.83 3.6-4.98 6.72-4.98z" />
              </svg>
              <span>Sign in with Google</span>
            </button>

            <button
              type="button"
              onClick={() => handleSignIn(githubProvider, "GitHub")}
              className="w-full flex items-center justify-center gap-3 bg-slate-900 text-white px-4 py-3 rounded-lg text-sm font-semibold hover:bg-slate-800 transition-all active:scale-95 shadow-sm"
            >
              <svg className="w-5 h-5 fill-current" viewBox="0 0 24 24">
                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
              </svg>
              <span>Sign in with GitHub</span>
            </button>

            {authError && (
              <p className="text-sm text-rose-600 bg-rose-50 px-3 py-2 rounded-lg">
                {authError}
              </p>
            )}
          </div>

          <p className="text-center text-xs text-slate-500">
            Identity via Firebase. Objects in MinIO on this machine.
          </p>
        </div>
      </div>
    );
  }

  const previewName = selectedFile?.originalName || selectedFile?.name || "";

  return (
    <div className="bg-slate-50 min-h-screen">
      <header className="fixed top-0 w-full z-50 bg-white/90 backdrop-blur border-b border-slate-200 flex justify-between items-center gap-4 h-16 px-4 md:px-8">
        <h1 className="text-xl font-bold text-blue-600 tracking-tight shrink-0">my_drive</h1>
        <div className="flex-1 max-w-xl hidden sm:flex items-center gap-2 bg-slate-100 rounded-full px-4 py-2">
          <span className="material-symbols-outlined text-slate-400 text-lg">search</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your files"
            className="bg-transparent w-full text-sm outline-none text-slate-700"
          />
        </div>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-full hover:bg-slate-100 transition-all"
            title="Account menu"
          >
            <img
              src={user.photoURL || "https://via.placeholder.com/32"}
              alt="Avatar"
              className="w-8 h-8 rounded-full object-cover bg-slate-200"
            />
            <span className="hidden md:inline text-slate-700 font-semibold text-sm">
              {user.displayName || "User"}
            </span>
            <span className="material-symbols-outlined text-sm text-slate-500">
              expand_more
            </span>
          </button>
          {menuOpen && (
            <div className="dropdown-menu">
              <div className="px-4 py-3 border-b border-slate-100 space-y-1">
                <div className="text-sm font-semibold text-slate-800">
                  {user.displayName || "User"}
                </div>
                <div className="text-xs text-slate-500 truncate">{user.email || ""}</div>
                <div className="text-xs text-slate-400">
                  UID: {user.uid ? `${user.uid.substring(0, 8)}...` : ""}
                </div>
              </div>
              <button
                type="button"
                onClick={copyCliToken}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-slate-700 hover:bg-slate-50 transition-colors text-sm font-semibold"
              >
                <span className="material-symbols-outlined text-lg">terminal</span>
                Copy CLI token
              </button>
              <button
                type="button"
                onClick={handleSignOut}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-rose-600 hover:bg-rose-50 transition-colors text-sm font-semibold"
              >
                <span className="material-symbols-outlined text-lg">logout</span>
                Logout
              </button>
            </div>
          )}
        </div>
      </header>

      <aside className="fixed left-0 top-0 h-full w-64 hidden md:flex flex-col border-r border-slate-200 bg-white pt-20 px-4 overflow-y-auto">
        <nav className="flex flex-col gap-1">
          {[
            { id: "all-files", icon: "folder", label: "All Files" },
            { id: "recent", icon: "schedule", label: "Recent" },
            { id: "starred", icon: "grade", label: "Starred" },
          ].map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setSection(item.id)}
              className={`flex items-center gap-3 px-4 py-2.5 rounded-full transition-all ${
                section === item.id
                  ? "bg-blue-50 text-blue-700 font-semibold"
                  : "text-slate-600 hover:bg-slate-100"
              }`}
            >
              <span className="material-symbols-outlined">{item.icon}</span>
              <span className="text-sm">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      {selectedFile && (
        <div
          className="fixed inset-0 z-30 bg-black bg-opacity-50 flex items-center justify-center overflow-y-auto"
          onClick={() => setSelectedFile(null)}
        >
          <div className="relative max-w-4xl w-full mx-4 my-8" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              onClick={() => setSelectedFile(null)}
              className="absolute -top-12 right-0 text-white hover:text-gray-300 transition-colors z-40"
            >
              <span className="material-symbols-outlined text-4xl">close</span>
            </button>
            <div className="bg-white rounded-lg overflow-hidden shadow-xl">
              {isImage(previewName) && (
                <AuthMedia
                  path={`/preview/${selectedFile.id}`}
                  token={token}
                  alt="Image preview"
                  className="w-full max-h-[80vh] object-contain bg-black"
                />
              )}
              {isVideo(previewName) && (
                <AuthMedia
                  path={`/preview/${selectedFile.id}`}
                  token={token}
                  alt="Video preview"
                  kind="video"
                  className="w-full max-h-[80vh] object-contain bg-black"
                />
              )}
              {isPdf(previewName) && (
                <AuthMedia
                  path={`/preview/${selectedFile.id}`}
                  token={token}
                  alt="PDF preview"
                  kind="iframe"
                  className="w-full h-[80vh]"
                />
              )}
              {isText(previewName) && (
                <div className="w-full max-h-[80vh] overflow-y-auto bg-slate-50 p-6">
                  <pre className="font-mono text-xs whitespace-pre-wrap break-words">
                    {previewText || "Unable to load preview"}
                  </pre>
                </div>
              )}
              {!canPreview(previewName) && (
                <div className="w-full h-80 flex items-center justify-center bg-slate-50">
                  <div className="text-center">
                    <span className="material-symbols-outlined text-8xl text-slate-300 mb-2">
                      insert_drive_file
                    </span>
                    <p className="text-sm text-slate-500">
                      {fileExtension(previewName).toUpperCase()} file preview not available
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <main className="pt-24 pb-24 md:pb-20 md:pl-72 px-4 md:pr-8">
        <div className="max-w-screen-xl mx-auto space-y-6">
        <div className="sm:hidden">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search your files"
            className="w-full border border-slate-200 rounded-xl px-4 py-2.5 text-sm"
          />
        </div>
          <section className="tonal-layer rounded-xl p-6 bg-white shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-800">Your Storage Bucket</h2>
              <span className="material-symbols-outlined text-slate-400">storage</span>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="w-full bg-slate-100 rounded-full h-2.5 overflow-hidden">
                  <div
                    className="h-full bg-blue-600 transition-all duration-300"
                    style={{ width: `${Math.min(storage.percentage || 0, 100)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-slate-600">
                    {storage.usedFormatted} used of {storage.limitFormatted}
                  </span>
                  <span className="font-semibold text-blue-600">
                    {storage.percentage || 0}%
                  </span>
                </div>
                {storage.bucketName && (
                  <p className="text-xs text-slate-400 font-mono">
                    Bucket: {storage.bucketName}
                  </p>
                )}
                {storage.node && (
                  <p className="text-xs text-slate-500">
                    This node ({storage.node.hostname}) has {storage.node.freeFormatted} free of{" "}
                    {storage.node.totalFormatted}
                  </p>
                )}
              </div>

              <form className="flex flex-col sm:flex-row sm:items-end gap-3" onSubmit={saveQuota}>
                <label className="flex-1 text-sm text-slate-600">
                  How much local disk to use (GB)
                  <input
                    type="number"
                    min="0.1"
                    step="0.1"
                    value={quotaGB}
                    onChange={(e) => setQuotaGB(e.target.value)}
                    className="mt-1 w-full border border-slate-300 rounded-lg px-3 py-2 text-slate-800"
                  />
                </label>
                <button
                  type="submit"
                  disabled={savingQuota}
                  className="bg-slate-900 text-white px-4 py-2.5 rounded-lg text-sm font-semibold hover:bg-slate-800 disabled:opacity-60"
                >
                  {savingQuota ? "Saving..." : "Set limit"}
                </button>
              </form>
              {quotaStatus && (
                <p
                  className={`text-sm ${
                    quotaStatus.ok ? "text-emerald-700" : "text-rose-600"
                  }`}
                >
                  {quotaStatus.text}
                </p>
              )}
            </div>
          </section>

          <section className="tonal-layer rounded-xl p-6 bg-white shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-slate-800">Upload files</h2>
              <span className="material-symbols-outlined text-slate-400">cloud_upload</span>
            </div>
            <form className="space-y-4" onSubmit={handleUpload}>
              <div
                className={`relative border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center bg-slate-50 transition-colors cursor-pointer group ${
                  dragActive ? "drop-active border-blue-500" : "border-slate-300 hover:border-blue-500"
                }`}
                onDragEnter={() => setDragActive(true)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragActive(false);
                  stageFiles(e.dataTransfer.files);
                }}
              >
                <input
                  ref={fileInputRef}
                  className="absolute inset-0 opacity-0 cursor-pointer"
                  type="file"
                  multiple
                  onChange={(e) =>
                    stageFiles(e.target.files)
                  }
                />
                <span className="material-symbols-outlined text-4xl text-slate-400 group-hover:text-blue-600 mb-2">
                  add_circle
                </span>
                <p className="text-sm text-slate-600">{chosenName}</p>
              </div>
              <button
                className="bg-blue-600 text-white px-6 py-2.5 rounded-lg text-sm font-semibold hover:bg-blue-700 active:scale-95 transition-all flex items-center gap-2 shadow-sm disabled:opacity-60"
                type="submit"
                disabled={uploading}
              >
                {!uploading && (
                  <span className="material-symbols-outlined text-lg">upload</span>
                )}
                <span>{uploading ? "Uploading..." : "Upload"}</span>
                {uploading && <div className="loading-ring" />}
              </button>
              {uploadJobs.length > 0 && (
                <div className="space-y-2">
                  {uploadJobs.map((job) => (
                    <div key={job.name} className="text-sm">
                      <div className="flex justify-between gap-2">
                        <span className="truncate text-slate-700">{job.name}</span>
                        <span
                          className={
                            job.status === "error"
                              ? "text-rose-600"
                              : job.status === "done"
                                ? "text-emerald-700"
                                : "text-slate-500"
                          }
                        >
                          {job.status === "error"
                            ? job.error
                            : job.status === "done"
                              ? "done"
                              : `${job.progress || 0}%`}
                        </span>
                      </div>
                      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
                        <div
                          className={`h-full ${
                            job.status === "error" ? "bg-rose-500" : "bg-blue-600"
                          }`}
                          style={{ width: `${job.progress || 0}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </form>
          </section>

          <section>
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-800">{sectionMeta.title}</h2>
                <span className="bg-blue-100 text-blue-800 px-2.5 py-0.5 rounded-full text-xs font-semibold">
                  {visibleFiles.length} Files
                </span>
              </div>
              <button
                type="button"
                className="flex items-center gap-1 text-blue-600 hover:bg-blue-50 px-3 py-1.5 rounded-lg transition-colors text-sm font-semibold"
                onClick={() => loadFiles(token)}
              >
                <span className="material-symbols-outlined text-lg">refresh</span>
                Refresh
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {filesLoading && (
                <div className="col-span-full py-12 flex flex-col items-center justify-center text-slate-400">
                  <div className="loading-ring mb-3 w-8 h-8" />
                  <p className="text-sm">Loading your files...</p>
                </div>
              )}
              {!filesLoading && filesError && (
                <p className="col-span-full text-center text-rose-600 text-sm py-8">
                  {filesError}
                </p>
              )}
              {!filesLoading && !filesError && files.length === 0 && (
                <div className="col-span-full py-16 flex flex-col items-center justify-center text-center space-y-3">
                  <div className="bg-slate-100 p-4 rounded-full">
                    <span className="material-symbols-outlined text-5xl text-slate-400">
                      folder_open
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-slate-800">No files found</h3>
                  <p className="text-sm text-slate-500 max-w-xs">
                    Start by uploading your first file to see it here.
                  </p>
                </div>
              )}
              {!filesLoading && !filesError && files.length > 0 && visibleFiles.length === 0 && (
                <p className="col-span-full text-center text-slate-500 text-sm py-8">
                  No files match “{search}”
                </p>
              )}
              {!filesLoading &&
                visibleFiles.map((file) => (
                  <FileCard
                    key={file.id}
                    file={file}
                    token={token}
                    onPreview={openPreview}
                    onDownload={downloadFile}
                    onStar={toggleStar}
                    onDelete={deleteFile}
                  />
                ))}
            </div>
          </section>
        </div>
      </main>

      <nav className="mobile-nav justify-around items-center pb-safe">
        {[
          { id: "all-files", icon: "folder", label: "Files" },
          { id: "recent", icon: "schedule", label: "Recent" },
          { id: "starred", icon: "grade", label: "Starred" },
        ].map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setSection(item.id)}
            className={`flex flex-col items-center text-xs ${
              section === item.id ? "text-blue-600" : "text-slate-500"
            }`}
          >
            <span className="material-symbols-outlined">{item.icon}</span>
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
