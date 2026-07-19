(function () {
  const BASE_URL = "https://redstoneapi.vercel.app";
  const STORAGE_KEY = "newsSidebarCollapsed";
  let newsRefreshInterval = null;

  async function loadNews() {
    const container = document.getElementById("news-sidebar-content");
    if (!container) return;

    try {
      const [sectionsRes, itemsRes] = await Promise.all([
        fetch(`${BASE_URL}/api/sections`).then((r) => r.json()),
        fetch(`${BASE_URL}/api/news`).then((r) => r.json())
      ]);

      const sections = sectionsRes.sections || [];
      const items = itemsRes.items || [];
      const sectionName = (id) => sections.find((s) => s.id === id)?.name ?? "General";

      if (items.length === 0) {
        container.innerHTML = '<div class="news-sidebar-empty">No news available</div>';
        return;
      }

      container.innerHTML = items
        .map(
          (item) => `
        <div class="news-item">
          <div class="news-meta">${sectionName(item.sectionId)} · ${new Date(item.createdAt).toLocaleDateString()}</div>
          <div class="news-title">${escapeHtml(item.title)}</div>
          <div class="news-content">${escapeHtml(item.content)}</div>
          ${item.hint ? `<div class="news-hint">${escapeHtml(item.hint)}</div>` : ""}
        </div>
      `
        )
        .join("");
    } catch (error) {
      container.innerHTML = '<div class="news-sidebar-empty">Failed to load news</div>';
    }
  }

  function escapeHtml(text) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }

  function setCollapsed(collapsed) {
    const sidebar = document.getElementById("news-sidebar");
    const body = document.body;
    if (!sidebar) return;
    sidebar.classList.toggle("collapsed", collapsed);
    body.classList.toggle("news-sidebar-collapsed", collapsed);
    localStorage.setItem(STORAGE_KEY, collapsed ? "1" : "0");
  }

  function setupSidebarControls() {
    const sidebar = document.getElementById("news-sidebar");
    const toggleBtn = document.querySelector(".news-sidebar-toggle");
    const closeBtn = document.querySelector(".news-sidebar-close");
    if (!sidebar) return;

    const isCollapsed = localStorage.getItem(STORAGE_KEY) === "1";
    setCollapsed(isCollapsed);

    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => {
        setCollapsed(!sidebar.classList.contains("collapsed"));
      });
    }

    if (closeBtn) {
      closeBtn.addEventListener("click", () => setCollapsed(true));
    }
  }

  function init() {
    setupSidebarControls();
    loadNews();
    if (newsRefreshInterval) clearInterval(newsRefreshInterval);
    newsRefreshInterval = setInterval(loadNews, 600000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.refreshNewsSidebar = loadNews;
})();
