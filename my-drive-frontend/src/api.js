function getApiUrl() {
  if (typeof window === "undefined") {
    return (process.env.REACT_APP_API_URL || "http://localhost:5000").replace(/\/$/, "");
  }

  const { hostname, port, origin } = window.location;
  const localDev =
    (hostname === "localhost" || hostname === "127.0.0.1") && port === "3000";

  if (localDev) {
    return (process.env.REACT_APP_API_URL || "http://localhost:5000").replace(/\/$/, "");
  }

  return origin.replace(/\/$/, "");
}

export { getApiUrl };

export async function authorizedFetch(url, token, options = {}) {
  if (!token) {
    throw new Error("No authentication token available");
  }

  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${token}`,
  };

  return fetch(url, { ...options, headers });
}

export async function saveUserProfile(user, token, provider) {
  const response = await authorizedFetch(`${getApiUrl()}/user/profile`, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      displayName: user.displayName,
      email: user.email,
      photoURL: user.photoURL,
      provider,
    }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || "Failed to save user profile");
  }

  return response.json();
}

export async function fetchAuthorizedBlob(path, token) {
  const response = await authorizedFetch(`${getApiUrl()}${path}`, token);
  if (!response.ok) {
    throw new Error("Failed to load file");
  }
  return response.blob();
}
