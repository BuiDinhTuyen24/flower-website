(() => {
  const CATEGORIES = ["Crochet", "Paper", "Felt & Fabric", "Knitted", "Quilling", "Origami", "Other"];
  const $ = (s) => document.querySelector(s);
  const grid = $("#grid"), search = $("#search");
  const state = { cat: "All", q: "", items: [], role: null, admin: false, editing: null,
    likes: new Set(JSON.parse(localStorage.getItem("likes") || "[]")) };

  const toast = (msg) => {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2400);
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // API (session lives in an HttpOnly cookie)
  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (opts.json) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
    const r = await fetch(path, { ...opts, headers, credentials: "same-origin" });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== "/api/login" && state.role) { showLogin(); toast("Please log in again"); }
    if (!r.ok) throw new Error(data.detail || `Request failed (${r.status})`);
    return data;
  }

  function setSession(me = {}) {
    state.role = me.role || null;
    state.admin = state.role === "admin";
    document.body.classList.toggle("is-admin", state.admin);
    document.body.classList.toggle("logged-out", !state.role);
    $("#who").innerHTML = state.role ? `Signed in as <b>${esc(me.username)}</b><span class="role">${esc(state.role)}</span>` : "";
  }

  async function loadItems() {
    try { state.items = await api("/api/pins"); }
    catch (e) { console.error(e); toast("Could not load products"); state.items = []; }
  }

  function renderNav() {
    const counts = state.items.reduce((m, i) => (m[i.category] = (m[i.category] || 0) + 1, m), {});
    const cats = ["All", ...CATEGORIES.filter((c) => counts[c]), ...(state.likes.size ? ["Liked"] : [])];
    if (!cats.includes(state.cat)) state.cat = "All";
    const n = (c) => c === "All" ? state.items.length : c === "Liked" ? state.items.filter((i) => state.likes.has(i.id)).length : counts[c];
    $("#categories").innerHTML = cats.map((c) =>
      `<button class="cat ${c === state.cat ? "active" : ""}" data-cat="${esc(c)}"><span>${c === "Liked" ? "♥ " : ""}${esc(c)}</span><span class="count">${n(c)}</span></button>`).join("");
    $("#chips").innerHTML = cats.map((c) => `<button class="chip ${c === state.cat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("");
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    return state.items.filter((i) =>
      (state.cat === "All" || (state.cat === "Liked" ? state.likes.has(i.id) : i.category === state.cat)) &&
      (!q || `${i.title} ${i.category} ${i.desc}`.toLowerCase().includes(q)));
  }

  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
  }), { rootMargin: "60px" });

  let renderToken = 0;
  async function renderGrid() {
    const tk = ++renderToken;
    const old = [...grid.children];
    if (old.length) { old.forEach((el) => el.classList.add("out")); await new Promise((r) => setTimeout(r, 180)); }
    if (tk !== renderToken) return;
    const list = filtered();
    $("#empty").hidden = list.length > 0;
    grid.innerHTML = list.map((i) => {
      const ratio = i.w && i.h ? `style="aspect-ratio:${+i.w}/${+i.h}"` : "";
      const media = i.type === "video"
        ? `<video src="${esc(i.src)}" muted loop playsinline preload="metadata" ${ratio}></video>`
        : `<img src="${esc(i.src)}" alt="${esc(i.title)}" loading="lazy" ${ratio}>`;
      const liked = state.likes.has(i.id);
      return `<article class="pin" tabindex="0" data-id="${esc(i.id)}">
        ${media}
        ${i.type === "video" ? '<span class="badge">▶ Video</span>' : ""}
        <button class="save ${liked ? "liked" : ""}" data-like="${esc(i.id)}">${liked ? "♥ Liked" : "Like"}</button>
        <div class="overlay"><b>${esc(i.title)}</b><span>${esc(i.category)}</span></div>
      </article>`;
    }).join("");
    [...grid.children].forEach((el, idx) => { el.style.transitionDelay = Math.min(idx, 12) * 35 + "ms"; io.observe(el); });
    grid.querySelectorAll("video").forEach((v) => {
      const p = v.closest(".pin");
      p.addEventListener("mouseenter", () => v.play().catch(() => {}));
      p.addEventListener("mouseleave", () => v.pause());
    });
  }

  const render = () => { renderNav(); renderGrid(); };

  function toggleLike(id) {
    state.likes.has(id) ? state.likes.delete(id) : state.likes.add(id);
    localStorage.setItem("likes", JSON.stringify([...state.likes]));
    const liked = state.likes.has(id);
    grid.querySelectorAll(`[data-like="${CSS.escape(id)}"]`).forEach((b) => { b.classList.toggle("liked", liked); b.textContent = liked ? "♥ Liked" : "Like"; });
    renderNav();
    return liked;
  }

  // modals
  const open = (m) => { m.classList.add("open"); m.setAttribute("aria-hidden", "false"); document.body.style.overflow = "hidden"; };
  const close = (m) => {
    m.classList.remove("open"); m.setAttribute("aria-hidden", "true");
    if (!document.querySelector(".modal.open")) document.body.style.overflow = "";
    m.querySelectorAll("video").forEach((v) => v.pause());
  };
  document.querySelectorAll(".modal").forEach((m) => m.addEventListener("click", (e) => {
    if (e.target === m || e.target.closest("[data-close]")) close(m);
  }));

  let current = null;
  function showViewer(id) {
    const i = state.items.find((x) => x.id === id); if (!i) return;
    current = i;
    $("#viewerMedia").innerHTML = i.type === "video"
      ? `<video src="${esc(i.src)}" controls autoplay playsinline loop></video>`
      : `<img src="${esc(i.src.replace(/\/\d+px-/, "/1200px-"))}" onerror="this.onerror=null;this.src='${esc(i.src)}'" alt="${esc(i.title)}">`;
    $("#viewerCat").textContent = i.category;
    $("#viewerTitle").textContent = i.title;
    $("#viewerDesc").textContent = i.desc || "";
    $("#viewerCredit").innerHTML = i.credit ? `Photo: <a href="${esc(i.credit)}" target="_blank" rel="noopener">Wikimedia Commons</a> · ${esc(i.license || "")}` : "";
    const lb = $("#likeBtn"); const liked = state.likes.has(i.id);
    lb.classList.toggle("liked", liked); lb.textContent = liked ? "♥ Liked" : "♡ Like";
    open($("#viewer"));
  }
  $("#likeBtn").onclick = () => { const l = toggleLike(current.id); $("#likeBtn").classList.toggle("liked", l); $("#likeBtn").textContent = l ? "♥ Liked" : "♡ Like"; };
  $("#deleteBtn").onclick = async () => {
    if (!confirm(`Delete "${current.title}"? This removes it for everyone.`)) return;
    try { await api(`/api/pins/${encodeURIComponent(current.id)}`, { method: "DELETE" }); }
    catch (e) { return toast(e.message); }
    close($("#viewer")); await loadItems(); render(); toast("Product deleted");
  };
  $("#editBtn").onclick = () => { close($("#viewer")); openEditor(current); };

  grid.addEventListener("click", (e) => {
    const like = e.target.closest("[data-like]");
    if (like) { e.stopPropagation(); toggleLike(like.dataset.like); return; }
    const pin = e.target.closest(".pin"); if (pin) showViewer(pin.dataset.id);
  });
  grid.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.classList.contains("pin")) showViewer(e.target.dataset.id); });

  const pickCat = (e) => {
    const b = e.target.closest("[data-cat]"); if (!b) return;
    state.cat = b.dataset.cat; document.body.classList.remove("nav-open"); render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  $("#categories").addEventListener("click", pickCat);
  $("#chips").addEventListener("click", pickCat);

  let st;
  search.addEventListener("input", () => { clearTimeout(st); st = setTimeout(() => { state.q = search.value; renderGrid(); }, 160); });
  addEventListener("keydown", (e) => {
    if (e.key === "/" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); search.focus(); }
    if (e.key === "Escape") document.querySelectorAll(".modal.open").forEach(close);
  });
  $("#menuBtn").onclick = () => document.body.classList.add("nav-open");
  $("#scrim").onclick = () => document.body.classList.remove("nav-open");

  // login / logout
  function showLogin() {
    document.querySelectorAll(".modal.open").forEach(close);
    document.body.classList.remove("nav-open");
    setSession({});
    state.items = []; grid.innerHTML = "";
    $("#loginErr").hidden = true; $("#loginPw").value = "";
    setTimeout(() => $("#loginUser").focus(), 50);
  }
  async function enter(me) {
    setSession(me);
    state.cat = "All"; state.q = ""; search.value = "";
    window.scrollTo(0, 0);
    await loadItems(); render();
  }
  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#loginSubmit"); btn.disabled = true; btn.textContent = "Logging in…";
    try {
      const me = await api("/api/login", { method: "POST", json: { username: $("#loginUser").value, password: $("#loginPw").value } });
      $("#loginForm").reset(); $("#loginErr").hidden = true;
      await enter(me); toast(`Welcome, ${me.username}`);
    } catch (err) {
      $("#loginErr").textContent = err.message; $("#loginErr").hidden = false;
      const card = $("#loginForm"); card.classList.remove("shake"); void card.offsetWidth; card.classList.add("shake");
    } finally { btn.disabled = false; btn.textContent = "Log in"; }
  });
  $("#logoutBtn").onclick = async () => {
    await api("/api/logout", { method: "POST" }).catch(() => {});
    showLogin(); toast("Logged out");
  };

  // add / edit product
  const fileIn = $("#file"), drop = $("#drop");
  let picked = null, previewUrl = null;
  $("#upCat").innerHTML = CATEGORIES.map((c) => `<option>${c}</option>`).join("");
  const emptyDrop = '<div class="drop-icon">⬆</div><b>Drop an image or video here</b><span>or click to choose a file (max 50 MB)</span>';
  const resetDrop = (html = emptyDrop) => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    picked = previewUrl = null; fileIn.value = "";
    $("#dropInner").innerHTML = html;
  };
  function setFile(f) {
    if (!f) return;
    if (!/^(image|video)\//.test(f.type)) return toast("Please choose an image or video");
    if (f.size > 50 * 1024 * 1024) return toast("File is larger than 50 MB");
    resetDrop(); picked = f; previewUrl = URL.createObjectURL(f);
    $("#dropInner").innerHTML = f.type.startsWith("video") ? `<video src="${previewUrl}" muted autoplay loop playsinline></video>` : `<img src="${previewUrl}" alt="preview">`;
    if (!$("#upTitle").value) $("#upTitle").value = f.name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").slice(0, 60);
  }
  fileIn.onchange = () => setFile(fileIn.files[0]);
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("drag"); }));
  drop.addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));

  function openEditor(item = null) {
    state.editing = item;
    $("#uploadForm").reset();
    $("#upHeading").textContent = item ? "Edit product" : "Add a product";
    $("#upSubmit").textContent = item ? "Save changes" : "Publish";
    $("#upHint").textContent = item ? "Leave the file as is to keep the current photo or video." : "Visible to everyone as soon as you publish.";
    if (item) {
      $("#upTitle").value = item.title; $("#upCat").value = item.category; $("#upDesc").value = item.desc || "";
      resetDrop(item.type === "video" ? `<video src="${esc(item.src)}" muted autoplay loop playsinline></video>` : `<img src="${esc(item.src)}" alt="current">`);
    } else resetDrop();
    document.body.classList.remove("nav-open");
    open($("#upload"));
  }
  [$("#openUpload"), $("#openUpload2")].forEach((b) => b.onclick = () => openEditor());

  const dims = (f, url) => new Promise((res) => {
    const el = f.type.startsWith("video") ? document.createElement("video") : new Image();
    const done = () => res({ w: el.naturalWidth || el.videoWidth || 0, h: el.naturalHeight || el.videoHeight || 0 });
    el.onload = el.onloadedmetadata = done; el.onerror = () => res({ w: 0, h: 0 });
    el.src = url;
  });

  $("#uploadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const editing = state.editing;
    if (!editing && !picked) return toast("Choose an image or video first");
    const fd = new FormData();
    fd.append("title", $("#upTitle").value); fd.append("category", $("#upCat").value); fd.append("desc", $("#upDesc").value);
    if (picked) {
      const { w, h } = await dims(picked, previewUrl);
      fd.append("file", picked); fd.append("w", w); fd.append("h", h);
    }
    const btn = $("#upSubmit"); btn.disabled = true; btn.textContent = picked ? "Uploading…" : "Saving…";
    try {
      await api(editing ? `/api/pins/${encodeURIComponent(editing.id)}` : "/api/pins", { method: editing ? "PUT" : "POST", body: fd });
    } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = editing ? "Save changes" : "Publish"; return; }
    btn.disabled = false;
    resetDrop(); close($("#upload"));
    if (!editing) { state.cat = "All"; state.q = ""; search.value = ""; }
    await loadItems(); render(); toast(editing ? "Changes saved" : "Product published 🌸");
    if (!editing) window.scrollTo({ top: 0, behavior: "smooth" });
  });

  $("#loginBg").innerHTML = (window.SEED_ITEMS || []).slice(0, 24)
    .map((i) => `<img src="${esc(i.src)}" alt="" loading="lazy">`).join("");

  (async () => {
    const me = await api("/api/me").catch(() => ({}));
    document.body.classList.remove("booting");
    if (me.role) await enter(me); else showLogin();
  })();
})();
