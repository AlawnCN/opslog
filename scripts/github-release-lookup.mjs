export const fetchGitHubRelease = async (repository, tag, token, fetcher = fetch) => {
  const base = `https://api.github.com/repos/${repository}/releases`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "OpsLog-release-verifier"
  };
  const tagged = await fetcher(`${base}/tags/${encodeURIComponent(tag)}`, { headers });
  if (tagged.ok) return tagged.json();
  if (tagged.status !== 404) throw new Error(`GitHub Release lookup failed: HTTP ${tagged.status}`);

  // The tag lookup returns 404 for a newly created draft. Authenticated list
  // results still include that draft, so verify it before making it public.
  for (let page = 1; ; page++) {
    const response = await fetcher(`${base}?per_page=100&page=${page}`, { headers });
    if (!response.ok) throw new Error(`GitHub Release list failed: HTTP ${response.status}`);
    const releases = await response.json();
    const draft = releases.find((release) => release.tag_name === tag);
    if (draft) return draft;
    if (releases.length < 100) break;
  }
  throw new Error(`GitHub Release ${tag} not found`);
};
