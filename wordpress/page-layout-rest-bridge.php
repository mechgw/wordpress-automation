<?php
/**
 * Plugin Name: WordPress Automation — GeneratePress Page Layout REST Bridge
 * Description: Adds narrowly scoped REST endpoints for the GeneratePress page-layout settings and for the Rank Math robots directives used by wordpress-automation.
 * Version: 1.2.0
 * License: MIT
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Only the three GeneratePress page-meta fields required by the layout-copy
 * workflow are exposed. Deliberately do not copy arbitrary post meta.
 *
 * @return string[]
 */
function wpa_page_layout_meta_keys() {
	return array(
		'_generate-sidebar-layout-meta',
		'_generate-full-width-content',
		'_generate-disable-headline',
	);
}

/**
 * Resolve the namespace already used by the Rank Math bridge.
 *
 * A constant/filter can override auto-discovery for installations that expose
 * more than one matching seo-meta endpoint. The value is the namespace only,
 * without /v1.
 *
 * @return string
 */
function wpa_page_layout_rest_namespace() {
	if ( defined( 'WP_AUTOMATION_REST_NAMESPACE' ) ) {
		$namespace = (string) WP_AUTOMATION_REST_NAMESPACE;
	} else {
		$namespace = (string) apply_filters( 'wp_automation_rest_namespace', '' );
	}

	$namespace = trim( $namespace, '/' );
	if ( '' !== $namespace ) {
		return preg_match( '/^[A-Za-z0-9_-]+$/', $namespace ) ? $namespace : '';
	}

	$matches = array();
	$routes  = rest_get_server()->get_routes();

	foreach ( array_keys( $routes ) as $route ) {
		if ( preg_match( '#^/([A-Za-z0-9_-]+)/v1/seo-meta/?$#', $route, $match ) ) {
			$matches[ $match[1] ] = true;
		}
	}

	if ( 1 !== count( $matches ) ) {
		return '';
	}

	$namespaces = array_keys( $matches );
	return (string) $namespaces[0];
}

/**
 * Dyrektywy robots dopuszczone przy zapisie. Świadomie wąska lista: wartość
 * spoza niej jest odrzucana, zanim cokolwiek zostanie zapisane.
 *
 * @return string[]
 */
function wpa_robots_directives() {
	return array(
		'index',
		'noindex',
		'follow',
		'nofollow',
		'noarchive',
		'noimageindex',
		'nosnippet',
	);
}

/**
 * Normalizuje wartość robots do listy dyrektyw. Przyjmuje tablicę (tak Rank Math
 * trzyma meta) albo tekst po przecinku (tak wygodniej w arkuszu). Pusta wartość
 * jest poprawna i oznacza „usuń ustawienie, wróć do domyślnych Rank Math”.
 *
 * @param mixed $value Raw value.
 * @return string[]|WP_Error
 */
function wpa_robots_normalize( $value ) {
	$parts = is_array( $value ) ? $value : explode( ',', (string) $value );
	$out   = array();

	foreach ( $parts as $part ) {
		$directive = strtolower( trim( (string) $part ) );
		if ( '' === $directive ) {
			continue;
		}
		if ( ! in_array( $directive, wpa_robots_directives(), true ) ) {
			return new WP_Error(
				'wp_automation_invalid_robots',
				'Unsupported robots directive: ' . $directive,
				array( 'status' => 400 )
			);
		}
		if ( ! in_array( $directive, $out, true ) ) {
			$out[] = $directive;
		}
	}

	// Sprzeczna para znaczy, że ktoś się pomylił; zapis takiej wartości kosztuje ruch organiczny.
	if ( in_array( 'index', $out, true ) && in_array( 'noindex', $out, true ) ) {
		return new WP_Error( 'wp_automation_invalid_robots', 'index and noindex are contradictory.', array( 'status' => 400 ) );
	}
	if ( in_array( 'follow', $out, true ) && in_array( 'nofollow', $out, true ) ) {
		return new WP_Error( 'wp_automation_invalid_robots', 'follow and nofollow are contradictory.', array( 'status' => 400 ) );
	}

	return $out;
}

/**
 * Aktualne robots strony jako tekst po przecinku; pusty tekst = brak własnego
 * ustawienia, czyli obowiązują domyślne Rank Math.
 *
 * @param int $post_id Page ID.
 * @return string
 */
function wpa_robots_read( $post_id ) {
	$raw = get_post_meta( $post_id, 'rank_math_robots', true );
	if ( ! is_array( $raw ) ) {
		$raw = ( '' === $raw || null === $raw ) ? array() : array( $raw );
	}

	$normalized = wpa_robots_normalize( $raw );
	if ( is_wp_error( $normalized ) ) {
		// Wartość zapisana poza tym mostem może być nietypowa; pokazujemy ją bez oceniania.
		return implode( ',', array_map( 'strval', $raw ) );
	}

	return implode( ',', $normalized );
}

/**
 * Return a page or a REST error without leaking unsupported post types into
 * the bridge.
 *
 * @param int $post_id Page ID.
 * @return WP_Post|WP_Error
 */
function wpa_page_layout_get_page( $post_id ) {
	$post = get_post( $post_id );

	if ( ! $post || 'page' !== $post->post_type ) {
		return new WP_Error(
			'wp_automation_page_not_found',
			'Page not found.',
			array( 'status' => 404 )
		);
	}

	return $post;
}

/**
 * Read the whitelist while preserving whether a meta key exists. Presence is
 * important: when a source key is absent, copying the layout must delete a
 * stale target value instead of silently retaining it.
 *
 * @param int $post_id Page ID.
 * @return array<string,array{exists:bool,value:mixed}>
 */
function wpa_page_layout_read_meta( $post_id ) {
	$layout = array();

	foreach ( wpa_page_layout_meta_keys() as $key ) {
		$exists = metadata_exists( 'post', $post_id, $key );
		$layout[ $key ] = array(
			'exists' => $exists,
			'value'  => $exists ? get_post_meta( $post_id, $key, true ) : null,
		);
	}

	return $layout;
}

/**
 * Build the response shape consumed by WordPress.gs::savePageLayoutResult_.
 *
 * @param WP_Post $post Page object.
 * @return array<string,mixed>
 */
function wpa_page_layout_page_payload( $post ) {
	return array(
		'id'       => (int) $post->ID,
		'slug'     => (string) $post->post_name,
		'status'   => (string) $post->post_status,
		'link'     => (string) get_permalink( $post ),
		'title'    => (string) get_the_title( $post ),
		'modified' => (string) get_post_modified_time( 'c', true, $post ),
		'layout'   => wpa_page_layout_read_meta( (int) $post->ID ),
	);
}

/**
 * GET permission: reject malformed input with 400, preserve the bridge's 404
 * for nonexistent/non-page posts, then enforce edit access for a real page.
 * Application Password authentication is handled by WordPress core.
 *
 * @param WP_REST_Request $request REST request.
 * @return bool|WP_Error
 */
function wpa_page_layout_can_read( $request ) {
	$post_id = absint( $request->get_param( 'post_id' ) );

	if ( $post_id <= 0 ) {
		return new WP_Error(
			'wp_automation_invalid_post_id',
			'Valid post_id is required.',
			array( 'status' => 400 )
		);
	}

	$post = wpa_page_layout_get_page( $post_id );
	if ( is_wp_error( $post ) ) {
		return $post;
	}

	return current_user_can( 'edit_post', $post_id );
}

/**
 * POST permission: validate source/target first, preserve page-not-found
 * errors, then require edit access to both real pages.
 *
 * @param WP_REST_Request $request REST request.
 * @return bool|WP_Error
 */
function wpa_page_layout_can_copy( $request ) {
	$source_id = absint( $request->get_param( 'source_post_id' ) );
	$target_id = absint( $request->get_param( 'target_post_id' ) );

	if ( $source_id <= 0 || $target_id <= 0 || $source_id === $target_id ) {
		return new WP_Error(
			'wp_automation_invalid_layout_copy',
			'Valid, distinct source_post_id and target_post_id are required.',
			array( 'status' => 400 )
		);
	}

	$source = wpa_page_layout_get_page( $source_id );
	if ( is_wp_error( $source ) ) {
		return $source;
	}

	$target = wpa_page_layout_get_page( $target_id );
	if ( is_wp_error( $target ) ) {
		return $target;
	}

	return current_user_can( 'edit_post', $source_id )
		&& current_user_can( 'edit_post', $target_id );
}

/**
 * Handle GET /page-layout?post_id=<id>.
 *
 * @param WP_REST_Request $request REST request.
 * @return WP_REST_Response|WP_Error
 */
function wpa_page_layout_get( $request ) {
	$post = wpa_page_layout_get_page( absint( $request->get_param( 'post_id' ) ) );
	if ( is_wp_error( $post ) ) {
		return $post;
	}

	return rest_ensure_response(
		array(
			'target'  => wpa_page_layout_page_payload( $post ),
			'changed' => null,
		)
	);
}

/**
 * Handle POST /page-layout. Copy only the strict GeneratePress whitelist and
 * verify the result by reading it back before returning success.
 *
 * @param WP_REST_Request $request REST request.
 * @return WP_REST_Response|WP_Error
 */
function wpa_page_layout_copy( $request ) {
	$source_id = absint( $request->get_param( 'source_post_id' ) );
	$target_id = absint( $request->get_param( 'target_post_id' ) );

	if ( $source_id <= 0 || $target_id <= 0 || $source_id === $target_id ) {
		return new WP_Error(
			'wp_automation_invalid_layout_copy',
			'Valid, distinct source_post_id and target_post_id are required.',
			array( 'status' => 400 )
		);
	}

	$source = wpa_page_layout_get_page( $source_id );
	$target = wpa_page_layout_get_page( $target_id );

	if ( is_wp_error( $source ) ) {
		return $source;
	}
	if ( is_wp_error( $target ) ) {
		return $target;
	}

	$source_layout = wpa_page_layout_read_meta( $source_id );
	$before_layout = wpa_page_layout_read_meta( $target_id );
	$before        = wpa_page_layout_page_payload( $target );
	$changed       = array();

	foreach ( wpa_page_layout_meta_keys() as $key ) {
		$source_meta = $source_layout[ $key ];
		$target_meta = $before_layout[ $key ];

		if ( $source_meta === $target_meta ) {
			continue;
		}

		if ( $source_meta['exists'] ) {
			$updated = update_post_meta( $target_id, $key, $source_meta['value'] );
			if ( false === $updated && get_post_meta( $target_id, $key, true ) !== $source_meta['value'] ) {
				return new WP_Error(
					'wp_automation_layout_write_failed',
					'Failed to update layout meta: ' . $key,
					array( 'status' => 500 )
				);
			}
		} else {
			delete_post_meta( $target_id, $key );
		}

		$changed[] = $key;
	}

	clean_post_cache( $target_id );
	$after_layout = wpa_page_layout_read_meta( $target_id );

	if ( $source_layout !== $after_layout ) {
		return new WP_Error(
			'wp_automation_layout_verification_failed',
			'Layout read-after-write verification failed.',
			array( 'status' => 500 )
		);
	}

	$target_after = get_post( $target_id );

	return rest_ensure_response(
		array(
			'source'  => wpa_page_layout_page_payload( $source ),
			'before'  => $before,
			'target'  => wpa_page_layout_page_payload( $target_after ),
			'changed' => $changed,
		)
	);
}

/**
 * POST permission dla /seo-robots: najpierw walidacja wejścia (400), potem
 * zachowanie 404 dla nieistniejącej strony, na końcu prawo edycji.
 *
 * @param WP_REST_Request $request REST request.
 * @return bool|WP_Error
 */
function wpa_robots_can_write( $request ) {
	$post_id = absint( $request->get_param( 'post_id' ) );

	if ( $post_id <= 0 ) {
		return new WP_Error(
			'wp_automation_invalid_post_id',
			'Valid post_id is required.',
			array( 'status' => 400 )
		);
	}

	$normalized = wpa_robots_normalize( $request->get_param( 'value' ) );
	if ( is_wp_error( $normalized ) ) {
		return $normalized;
	}

	$post = wpa_page_layout_get_page( $post_id );
	if ( is_wp_error( $post ) ) {
		return $post;
	}

	return current_user_can( 'edit_post', $post_id );
}

/**
 * Handle POST /seo-robots. Zapisuje wyłącznie meta rank_math_robots i
 * potwierdza wynik odczytem kontrolnym przed zwróceniem sukcesu.
 *
 * @param WP_REST_Request $request REST request.
 * @return WP_REST_Response|WP_Error
 */
function wpa_robots_write( $request ) {
	$post_id    = absint( $request->get_param( 'post_id' ) );
	$normalized = wpa_robots_normalize( $request->get_param( 'value' ) );

	if ( is_wp_error( $normalized ) ) {
		return $normalized;
	}

	$post = wpa_page_layout_get_page( $post_id );
	if ( is_wp_error( $post ) ) {
		return $post;
	}

	$before = wpa_robots_read( $post_id );

	if ( empty( $normalized ) ) {
		delete_post_meta( $post_id, 'rank_math_robots' );
	} else {
		update_post_meta( $post_id, 'rank_math_robots', $normalized );
	}

	clean_post_cache( $post_id );
	$after = wpa_robots_read( $post_id );

	if ( $after !== implode( ',', $normalized ) ) {
		return new WP_Error(
			'wp_automation_robots_verification_failed',
			'Robots read-after-write verification failed.',
			array( 'status' => 500 )
		);
	}

	return rest_ensure_response(
		array(
			'post_id' => (int) $post_id,
			'before'  => $before,
			'robots'  => $after,
			'changed' => $before !== $after,
		)
	);
}

/**
 * Register after the existing Rank Math bridge so its namespace can be
 * discovered from the already registered /v1/seo-meta route.
 */
add_action(
	'rest_api_init',
	function () {
		$namespace = wpa_page_layout_rest_namespace();
		if ( '' === $namespace ) {
			return;
		}

		register_rest_route(
			$namespace . '/v1',
			'/page-layout',
			array(
				array(
					'methods'             => WP_REST_Server::READABLE,
					'callback'            => 'wpa_page_layout_get',
					'permission_callback' => 'wpa_page_layout_can_read',
					'args'                => array(
						'post_id' => array(
							'required'          => true,
							'type'              => 'integer',
							'sanitize_callback' => 'absint',
						),
					),
				),
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => 'wpa_page_layout_copy',
					'permission_callback' => 'wpa_page_layout_can_copy',
					'args'                => array(
						'source_post_id' => array(
							'required'          => true,
							'type'              => 'integer',
							'sanitize_callback' => 'absint',
						),
						'target_post_id' => array(
							'required'          => true,
							'type'              => 'integer',
							'sanitize_callback' => 'absint',
						),
					),
				),
			)
		);

		register_rest_route(
			$namespace . '/v1',
			'/seo-robots',
			array(
				array(
					'methods'             => WP_REST_Server::CREATABLE,
					'callback'            => 'wpa_robots_write',
					'permission_callback' => 'wpa_robots_can_write',
					'args'                => array(
						'post_id' => array(
							'required'          => true,
							'type'              => 'integer',
							'sanitize_callback' => 'absint',
						),
						'value'   => array(
							'required' => true,
							'type'     => 'string',
						),
					),
				),
			)
		);
	},
	100
);

/**
 * Odczyt robots wystawiony jako pole REST strony, żeby WordPress.gs mógł je
 * pobrać razem z resztą danych jednym żądaniem (_fields=wpa_rank_math_robots).
 *
 * Pole jest rejestrowane pod dwiema nazwami. `wpa_rank_math_robots` to nazwa
 * docelowa, spójna z prefiksem funkcji w tym pliku. `cc_rank_math_robots` to
 * nazwa historyczna, zachowana wyłącznie na czas aktualizacji: skrypt czyta
 * nową, a starą tylko wtedy, gdy nowej nie ma. Po wgraniu tej wersji snippetu
 * do WordPressa starą nazwę można usunąć.
 */
add_action(
	'rest_api_init',
	function () {
		$robots_field = array(
			'get_callback' => function ( $page ) {
				return wpa_robots_read( (int) $page['id'] );
			},
			'schema'       => array(
				'description' => 'Rank Math robots directives as a comma-separated list; empty means Rank Math defaults.',
				'type'        => 'string',
				'context'     => array( 'edit' ),
			),
		);
		register_rest_field( 'page', 'wpa_rank_math_robots', $robots_field );
		register_rest_field( 'page', 'cc_rank_math_robots', $robots_field );
	},
	100
);
