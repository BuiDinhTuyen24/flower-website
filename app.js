(() => {
  const CATEGORIES = ["Crochet", "Paper", "Felt & Fabric", "Knitted", "Quilling", "Origami", "Other"];
  const $ = (s) => document.querySelector(s);
  const grid = $("#grid"), search = $("#search");
  const state = { cat: "All", q: "", items: [], likes: new Set(JSON.parse(localStorage.getItem("likes") || "[]")) };

  // IndexedDB for user uploads (images + videos as Blobs)
  const dbp = new Promise((res, rej) => {
    const r = indexedDB.open("petal-thread", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("pins", { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = async (mode, fn) => {
    const db = await dbp;
    return new Promise((res, rej) => {
      const t = db.transaction("pins", mode), req = fn(t.objectStore("pins"));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  const dbAll = () => tx("readonly", (s) => s.getAll());
  const dbPut = (v) => tx("readwrite", (s) => s.put(v));
  const dbDel = (id) => tx("readwrite", (s) => s.delete(id));

  const toast = (msg) => {
    const t = $("#toast"); t.textContent = msg; t.classList.add("show");
    clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove("show"), 2200);
  };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function loadItems() {
    const seed = (window.SEED_ITEMS || []).map((it, i) => ({ ...it, id: "seed-" + i, type: "image", user: false,
      desc: it.desc || `A handmade ${it.category.toLowerCase()} piece. ${it.license ? "License: " + it.license + "." : ""}` }));
    let mine = [];
    try {
      const all = await Promise.race([dbAll(), new Promise((_, rej) => setTimeout(() => rej(new Error("IndexedDB timeout")), 1500))]);
      mine = all.sort((a, b) => b.created - a.created)
        .map((p) => ({ ...p, src: URL.createObjectURL(p.blob), user: true }));
    } catch (e) { console.warn("IndexedDB unavailable", e); }
    state.items.forEach((i) => i.user && URL.revokeObjectURL(i.src));
    state.items = [...mine, ...seed];
  }

  function renderNav() {
    const counts = state.items.reduce((m, i) => (m[i.category] = (m[i.category] || 0) + 1, m), {});
    const cats = ["All", ...CATEGORIES.filter((c) => counts[c]), ...(state.likes.size ? ["Liked"] : [])];
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
    const token = ++renderToken;
    const old = [...grid.children];
    if (old.length) { old.forEach((el) => el.classList.add("out")); await new Promise((r) => setTimeout(r, 180)); }
    if (token !== renderToken) return;
    const list = filtered();
    $("#empty").hidden = list.length > 0;
    grid.innerHTML = list.map((i) => {
      const ratio = i.w && i.h ? `style="aspect-ratio:${i.w}/${i.h}"` : "";
      const media = i.type === "video"
        ? `<video src="${i.src}" muted loop playsinline preload="metadata"></video>`
        : `<img src="${esc(i.src)}" alt="${esc(i.title)}" loading="lazy" ${ratio}>`;
      return `<article class="pin" tabindex="0" data-id="${esc(i.id)}">
        ${media}
        ${i.type === "video" ? '<span class="badge">▶ Video</span>' : i.user ? '<span class="badge">Yours</span>' : ""}
        <button class="save ${state.likes.has(i.id) ? "liked" : ""}" data-like="${esc(i.id)}">${state.likes.has(i.id) ? "♥ Liked" : "Like"}</button>
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
    m.classList.remove("open"); m.setAttribute("aria-hidden", "true"); document.body.style.overflow = "";
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
      ? `<video src="${i.src}" controls autoplay playsinline loop></video>`
      : `<img src="${esc(i.src.replace(/\/\d+px-/, "/1200px-"))}" onerror="this.onerror=null;this.src='${esc(i.src)}'" alt="${esc(i.title)}">`;
    $("#viewerCat").textContent = i.category;
    $("#viewerTitle").textContent = i.title;
    $("#viewerDesc").textContent = i.desc || "";
    $("#viewerCredit").innerHTML = i.credit ? `Photo: <a href="${esc(i.credit)}" target="_blank" rel="noopener">Wikimedia Commons</a> · ${esc(i.license || "")}` : i.user ? "Uploaded by you" : "";
    const lb = $("#likeBtn"); const liked = state.likes.has(i.id);
    lb.classList.toggle("liked", liked); lb.textContent = liked ? "♥ Liked" : "♡ Like";
    $("#deleteBtn").hidden = !i.user;
    open($("#viewer"));
  }
  $("#likeBtn").onclick = () => { const l = toggleLike(current.id); $("#likeBtn").classList.toggle("liked", l); $("#likeBtn").textContent = l ? "♥ Liked" : "♡ Like"; };
  $("#deleteBtn").onclick = async () => {
    if (!confirm("Delete this pin?")) return;
    await dbDel(current.id); close($("#viewer")); await loadItems(); render(); toast("Pin deleted");
  };

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

  // upload
  const fileIn = $("#file"), drop = $("#drop");
  let picked = null, previewUrl = null;
  $("#upCat").innerHTML = CATEGORIES.map((c) => `<option>${c}</option>`).join("");
  const resetDrop = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    picked = previewUrl = null; fileIn.value = "";
    $("#dropInner").innerHTML = '<div class="drop-icon">⬆</div><b>Drop an image or video here</b><span>or click to choose a file (max 50 MB)</span>';
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
  [$("#openUpload"), $("#openUpload2")].forEach((b) => b.onclick = () => { document.body.classList.remove("nav-open"); open($("#upload")); });

  const dims = (f, url) => new Promise((res) => {
    const el = f.type.startsWith("video") ? document.createElement("video") : new Image();
    const done = () => res({ w: el.naturalWidth || el.videoWidth || 0, h: el.naturalHeight || el.videoHeight || 0 });
    el.onload = el.onloadedmetadata = done; el.onerror = () => res({ w: 0, h: 0 });
    el.src = url;
  });

  $("#uploadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!picked) return toast("Choose an image or video first");
    const { w, h } = await dims(picked, previewUrl);
    const pin = { id: "u-" + Date.now(), title: $("#upTitle").value.trim(), category: $("#upCat").value,
      desc: $("#upDesc").value.trim(), type: picked.type.startsWith("video") ? "video" : "image", blob: picked, w, h, created: Date.now() };
    try { await dbPut(pin); } catch (err) { return toast("Could not save: storage full?"); }
    e.target.reset(); resetDrop(); close($("#upload"));
    state.cat = "All"; state.q = ""; search.value = "";
    await loadItems(); render(); toast("Pin published 🌸");
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  loadItems().then(render).catch((e) => { console.error(e); render(); });
})();
