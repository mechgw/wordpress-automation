'use strict';

/**
 * Stanowy fałszywy WordPress dla testów komend: odpowiada na odczyty po
 * zapisach, więc odczyty kontrolne w komendach widzą efekt POST-ów.
 *
 * Obsługiwane trasy (prefiks bazy dowolny):
 *   GET  /wp-json/wp/v2/pages?slug=…            lista stron o slugu (po statusie z query, jeśli podano)
 *   GET  /wp-json/wp/v2/pages?status=…&page=N   stronicowana lista (nagłówek X-WP-TotalPages)
 *   GET  /wp-json/wp/v2/pages/:id               jedna strona (context=edit → pola raw + cc_rank_math)
 *   POST /wp-json/wp/v2/pages                   utworzenie (nadaje id)
 *   POST /wp-json/wp/v2/pages/:id               aktualizacja pól title/excerpt/content/status/slug
 *   GET  /wp-json/wp/v2/media/:id, /media?search=…
 *   POST /wp-json/wp/v2/media/:id               aktualizacja title/alt_text/caption/description
 *   GET/POST /wp-json/<ns>/v1/seo-meta          odczyt/zapis rank_math_title / rank_math_description
 *
 * `failures` pozwala wymusić odpowiedź dla konkretnej trasy: { 'POST /wp-json/wp/v2/pages/7': { code: 500, text: 'boom' } }.
 * Opcja `readBackLies` symuluje WordPress, który przyjął zapis, ale odczyt kontrolny nie odzwierciedla zmiany.
 */
function fakeWordPress({ pages = [], media = [], failures = {}, readBackLies = false, perPage = 100 } = {}) {
  const state = {
    pages: new Map(pages.map(p => [Number(p.id), normalizePage(p)])),
    media: new Map(media.map(m => [Number(m.id), normalizeMedia(m)])),
    nextId: Math.max(0, ...pages.map(p => Number(p.id)), ...media.map(m => Number(m.id))) + 1,
    writes: []
  };

  function normalizePage(p) {
    return {
      id: Number(p.id), slug: p.slug || '', status: p.status || 'draft', link: p.link || `https://www.example.pl/${p.slug || ''}/`,
      title: p.title || '', excerpt: p.excerpt || '', content: p.content || '', modified: p.modified || '2026-09-01T00:00:00',
      rankMath: Object.assign({ title: '', description: '' }, p.rankMath || {}), hasRankMath: p.hasRankMath !== false,
      // Robots wystawia osobne pole REST z page-layout-rest-bridge.php; hasRobots:false
      // odwzorowuje instalację ze starym snippetem, bez obsługi robots.
      robots: p.robots === undefined ? '' : String(p.robots), hasRobots: p.hasRobots !== false
    };
  }
  function normalizeMedia(m) {
    return {
      id: Number(m.id), slug: m.slug || `media-${m.id}`, status: 'inherit', title: m.title || '', alt_text: m.alt_text || '',
      caption: m.caption || '', description: m.description || '', source_url: m.source_url || `https://www.example.pl/wp-content/uploads/${m.slug || 'file'}.jpg`,
      mime_type: m.mime_type || 'image/jpeg', modified: m.modified || '2026-09-01T00:00:00', media_details: m.media_details || { width: 800, height: 600 }
    };
  }
  const pageJson = p => ({
    id: p.id, slug: p.slug, status: p.status, link: p.link,
    title: { raw: p.title, rendered: p.title }, excerpt: { raw: p.excerpt, rendered: p.excerpt }, content: { raw: p.content, rendered: p.content },
    modified: p.modified, ...(p.hasRankMath ? { cc_rank_math: { title: p.rankMath.title, description: p.rankMath.description } } : {}),
    ...(p.hasRobots ? { cc_rank_math_robots: p.robots } : {})
  });
  const mediaJson = m => ({
    id: m.id, slug: m.slug, status: m.status, link: m.source_url, title: { raw: m.title, rendered: m.title }, alt_text: m.alt_text,
    caption: { raw: m.caption, rendered: m.caption }, description: { raw: m.description, rendered: m.description },
    source_url: m.source_url, mime_type: m.mime_type, modified: m.modified, media_details: m.media_details
  });
  const ok = (json, headers) => ({ code: 200, json, headers: headers || {} });
  const notFound = () => ({ code: 404, text: '{"code":"rest_post_invalid_id"}' });

  function handle(url, params) {
    const method = String((params && params.method) || 'get').toUpperCase();
    const u = new URL(url);
    const key = `${method} ${u.pathname}`;
    if (failures[key]) return failures[key];
    const q = u.searchParams;
    const body = params && params.payload ? JSON.parse(params.payload) : {};
    if (method !== 'GET') state.writes.push({ method, path: u.pathname, body });

    let m;
    if ((m = /^\/wp-json\/wp\/v2\/pages\/(\d+)$/.exec(u.pathname))) {
      const page = state.pages.get(Number(m[1]));
      if (!page) return notFound();
      if (method === 'POST') {
        if (!readBackLies) {
          for (const f of ['title', 'excerpt', 'content', 'status', 'slug']) if (body[f] !== undefined) page[f] = String(body[f]);
          page.modified = '2026-09-05T12:00:00';
        }
        return ok(pageJson(page));
      }
      return ok(pageJson(page));
    }
    if (u.pathname === '/wp-json/wp/v2/pages') {
      if (method === 'POST') {
        const id = state.nextId++;
        const page = normalizePage({ id, slug: body.slug, title: body.title, content: body.content, status: body.status || 'draft' });
        if (readBackLies) page.status = 'publish';
        state.pages.set(id, page);
        return { code: 201, json: pageJson(page) };
      }
      let list = [...state.pages.values()];
      if (q.get('slug')) list = list.filter(p => p.slug === q.get('slug'));
      if (q.get('status')) { const st = q.get('status').split(','); list = list.filter(p => st.includes(p.status)); }
      const pageNo = Number(q.get('page') || 1);
      const total = Math.max(1, Math.ceil(list.length / perPage));
      const slice = list.slice((pageNo - 1) * perPage, pageNo * perPage);
      return ok(slice.map(pageJson), { 'X-WP-TotalPages': String(total) });
    }
    if ((m = /^\/wp-json\/wp\/v2\/media\/(\d+)$/.exec(u.pathname))) {
      const item = state.media.get(Number(m[1]));
      if (!item) return notFound();
      if (method === 'POST' && !readBackLies) {
        for (const f of ['title', 'alt_text', 'caption', 'description']) if (body[f] !== undefined) item[f] = String(body[f]);
      }
      return ok(mediaJson(item));
    }
    if (u.pathname === '/wp-json/wp/v2/media') {
      const search = (q.get('search') || '').toLowerCase();
      const list = [...state.media.values()].filter(x => !search || x.title.toLowerCase().includes(search) || x.slug.includes(search));
      return ok(list.map(mediaJson));
    }
    if (/^\/wp-json\/[a-z0-9_-]+\/v1\/seo-robots$/.test(u.pathname)) {
      if (method === 'POST') {
        const page = state.pages.get(Number(body.post_id));
        if (!page) return notFound();
        const list = String(body.value || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const allowed = ['index', 'noindex', 'follow', 'nofollow', 'noarchive', 'noimageindex', 'nosnippet'];
        const bad = list.find(d => !allowed.includes(d));
        if (bad) return { code: 400, text: JSON.stringify({ code: 'wp_automation_invalid_robots', message: 'Unsupported robots directive: ' + bad }) };
        const before = page.robots;
        if (!readBackLies) page.robots = list.join(',');
        return ok({ post_id: page.id, before, robots: page.robots, changed: before !== page.robots });
      }
      return ok({ ok: true });
    }

    if (/^\/wp-json\/[a-z0-9_-]+\/v1\/seo-meta$/.test(u.pathname)) {
      if (method === 'POST') {
        const page = state.pages.get(Number(body.post_id));
        if (!page) return notFound();
        if (!readBackLies) page.rankMath[body.field === 'rank_math_title' ? 'title' : 'description'] = String(body.value);
        return ok({ ok: true });
      }
      return ok({ ok: true });
    }
    if (/^\/wp-json\/[a-z0-9_-]+\/v1\/page-layout$/.test(u.pathname)) {
      const id = Number(q.get('post_id') || body.target_post_id);
      const page = state.pages.get(id);
      if (!page) return notFound();
      return ok({ target: { id: page.id, slug: page.slug, status: page.status, link: page.link, title: page.title, modified: page.modified }, changed: method === 'POST' ? ['layout'] : null });
    }
    return { code: 404, text: `no fake route for ${key}` };
  }

  return { fetch: handle, state };
}

module.exports = { fakeWordPress };
