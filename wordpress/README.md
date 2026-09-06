# WordPress-side bridge

`WordPress.gs` is only the client. Operations that touch protected WordPress/plugin meta need a small server-side REST bridge as well.

## GeneratePress page-layout bridge

`page-layout-rest-bridge.php` implements the endpoint used by:

- `GET_PAGE_LAYOUT`
- `COPY_PAGE_LAYOUT`

It deliberately exposes only three GeneratePress page-level settings:

- `_generate-sidebar-layout-meta` — sidebar layout;
- `_generate-full-width-content` — full-width/page-builder container mode;
- `_generate-disable-headline` — content title visibility.

The write endpoint copies presence as well as value. If the source page does not have a whitelisted meta key, a stale value on the target page is deleted. The response is then read back and compared before success is returned.

## Rank Math robots bridge

The same snippet also implements `POST /wp-json/<WP_REST_NAMESPACE>/v1/seo-robots` and the read-only REST field `cc_rank_math_robots` on pages. Together they let `UPDATE_RANK_MATH_FIELD` set the field `rank_math_robots`, which the older `seo-meta` bridge cannot do (it handles only the SEO title and description).

Design notes:

- the value travels as a comma-separated list (`noindex,follow`) because that is what a sheet cell holds; Rank Math stores it as an array and the bridge converts;
- only these directives are accepted, on both sides: `index`, `noindex`, `follow`, `nofollow`, `noarchive`, `noimageindex`, `nosnippet`. Anything else is a 400 before any write;
- contradictory pairs (`index` with `noindex`, `follow` with `nofollow`) are rejected as well: writing one by mistake costs organic traffic;
- an empty value deletes the meta, which means "fall back to the Rank Math defaults";
- the write is verified by reading the meta back, exactly like the layout copy;
- permission is `edit_post` on a real page, and a malformed request is a 400 before the page is even loaded.

**Updating an existing installation:** this endpoint arrived in version 1.1.0 of the snippet. Until the WordPress side is updated, `UPDATE_RANK_MATH_FIELD` with `rank_math_robots` refuses with a message naming the file to update, and *WordPress → Test Rank Math bridge* reports the robots support as missing. Nothing else changes; the layout endpoints keep working.

## REST namespace

The Apps Script client uses `WP_REST_NAMESPACE` and calls:

`/wp-json/<WP_REST_NAMESPACE>/v1/page-layout`

The PHP bridge avoids committing any site-specific namespace. On `rest_api_init` it first checks:

1. the optional `WP_AUTOMATION_REST_NAMESPACE` PHP constant;
2. the optional `wp_automation_rest_namespace` filter;
3. otherwise, it auto-discovers the single namespace that already exposes `/v1/seo-meta` from the existing Rank Math bridge.

For the current installation, auto-discovery is the preferred path because Rank Math already uses the configured Apps Script namespace.

## Installation

This PHP file is **not deployed by clasp**. `.claspignore` intentionally sends only `*.gs` and `appsscript.json` to Apps Script.

Install the PHP bridge on WordPress using one of these approaches:

- preferred for versioned server configuration: copy `page-layout-rest-bridge.php` to `wp-content/mu-plugins/`;
- alternatively, paste the file body into a trusted PHP snippets mechanism, omitting the opening `<?php` when that tool requires code without it.

Do not enable the `COPY_PAGE_LAYOUT` workflow until the bridge is installed and `GET_PAGE_LAYOUT` succeeds.

## Authentication and safety

The endpoint relies on normal WordPress Application Password authentication already used by `WordPress.gs`.

- GET requires `edit_post` capability for the requested page.
- POST requires `edit_post` capability for both source and target pages.
- only WordPress `page` posts are accepted;
- arbitrary post meta cannot be read or copied;
- source and target IDs must be different;
- POST performs read-after-write verification before returning success.
