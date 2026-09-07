<?php
/**
 * Plugin Name: WordPress Automation — Rank Math SEO meta REST Bridge
 * Description: Reads and writes the Rank Math SEO title and description used by wordpress-automation.
 * Version: 1.0.0
 * License: MIT
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Ten most istniał do tej pory wyłącznie jako snippet w instalacji, poza
 * kontrolą wersji (#103). Wersja tutaj odtwarza kontrakt, z którego korzysta
 * WordPress.gs, i dokłada neutralną nazwę pola REST.
 *
 * Zakres jest świadomie wąski: tytuł i opis SEO. Robots ma osobny endpoint
 * w page-layout-rest-bridge.php, bo wymaga listy dyrektyw i innej walidacji.
 */

/**
 * Pola Rank Math, które ten most wolno zapisać. Cokolwiek spoza listy jest
 * odrzucane przed zapisem: most nie może być furtką do dowolnego post meta.
 *
 * @return string[]
 */
function wpa_seo_meta_fields() {
	return array(
		'rank_math_title',
		'rank_math_description',
	);
}

/**
 * Namespace wspólny z pozostałymi endpointami automatyzacji.
 *
 * @return string
 */
function wpa_seo_meta_namespace() {
	if ( defined( 'WP_AUTOMATION_REST_NAMESPACE' ) ) {
		$namespace = (string) WP_AUTOMATION_REST_NAMESPACE;
	} else {
		$namespace = (string) apply_filters( 'wp_automation_rest_namespace', '' );
	}

	$namespace = trim( $namespace, '/' );
	return preg_match( '/^[A-Za-z0-9_-]+$/', $namespace ) ? $namespace : '';
}

/**
 * Aktualne wartości SEO title i description strony.
 *
 * @param int $post_id Page ID.
 * @return array<string,string>
 */
function wpa_seo_meta_read( $post_id ) {
	return array(
		'title'       => (string) get_post_meta( $post_id, 'rank_math_title', true ),
		'description' => (string) get_post_meta( $post_id, 'rank_math_description', true ),
	);
}

/**
 * Uprawnienia zapisu: najpierw poprawność wejścia (400), potem istnienie
 * strony (404), na końcu prawo edycji. Kolejność ma znaczenie, bo inaczej
 * nieistniejące ID wyglądałoby jak brak uprawnień.
 *
 * @param WP_REST_Request $request REST request.
 * @return bool|WP_Error
 */
function wpa_seo_meta_can_write( $request ) {
	$post_id = absint( $request->get_param( 'post_id' ) );
	$field   = (string) $request->get_param( 'field' );

	if ( $post_id <= 0 ) {
		return new WP_Error( 'wp_automation_invalid_post_id', 'Valid post_id is required.', array( 'status' => 400 ) );
	}
	if ( ! in_array( $field, wpa_seo_meta_fields(), true ) ) {
		return new WP_Error(
			'wp_automation_invalid_field',
			'Unsupported field: ' . $field,
			array( 'status' => 400 )
		);
	}

	$post = get_post( $post_id );
	if ( ! $post || 'page' !== $post->post_type ) {
		return new WP_Error( 'wp_automation_page_not_found', 'Page not found.', array( 'status' => 404 ) );
	}

	return current_user_can( 'edit_post', $post_id );
}

/**
 * Zapis pojedynczego pola z odczytem kontrolnym. Pusta wartość usuwa meta,
 * co dla Rank Matha znaczy „wróć do szablonu”, a nie „ustaw pusty tytuł”.
 *
 * @param WP_REST_Request $request REST request.
 * @return WP_REST_Response|WP_Error
 */
function wpa_seo_meta_write( $request ) {
	$post_id = absint( $request->get_param( 'post_id' ) );
	$field   = (string) $request->get_param( 'field' );
	$value   = (string) $request->get_param( 'value' );

	$before = wpa_seo_meta_read( $post_id );

	if ( '' === $value ) {
		delete_post_meta( $post_id, $field );
	} else {
		update_post_meta( $post_id, $field, $value );
	}

	$after  = wpa_seo_meta_read( $post_id );
	$stored = (string) get_post_meta( $post_id, $field, true );

	// Odczyt kontrolny po stronie WordPressa: filtr albo inna wtyczka mogły
	// zmienić wartość po drodze, a skrypt musi się o tym dowiedzieć teraz.
	if ( $stored !== $value ) {
		return new WP_Error(
			'wp_automation_seo_meta_verification_failed',
			'Stored value differs from the requested one after write.',
			array( 'status' => 500 )
		);
	}

	return rest_ensure_response(
		array(
			'post_id' => $post_id,
			'field'   => $field,
			'before'  => $before,
			'after'   => $after,
			'changed' => $before !== $after,
		)
	);
}

add_action(
	'rest_api_init',
	function () {
		$namespace = wpa_seo_meta_namespace();
		if ( '' === $namespace ) {
			return;
		}

		register_rest_route(
			$namespace . '/v1',
			'/seo-meta',
			array(
				'methods'             => 'POST',
				'callback'            => 'wpa_seo_meta_write',
				'permission_callback' => 'wpa_seo_meta_can_write',
				'args'                => array(
					'post_id' => array( 'required' => true ),
					'field'   => array( 'required' => true ),
					'value'   => array( 'required' => false ),
				),
			)
		);
	},
	100
);

/**
 * Odczyt wystawiony jako pole REST strony, żeby WordPress.gs pobrał SEO title
 * i description razem z resztą danych jednym żądaniem.
 *
 * Pole jest rejestrowane pod dwiema nazwami. `wpa_rank_math` to nazwa docelowa,
 * spójna z prefiksem funkcji. `cc_rank_math` to nazwa historyczna, pochodząca
 * od skrótu nazwy firmy, zachowana wyłącznie na czas aktualizacji: skrypt czyta
 * nową, a starą tylko wtedy, gdy nowej nie ma. Po wgraniu tej wersji do
 * WordPressa starą nazwę można usunąć.
 */
add_action(
	'rest_api_init',
	function () {
		$seo_field = array(
			'get_callback' => function ( $page ) {
				return wpa_seo_meta_read( (int) $page['id'] );
			},
			'schema'       => array(
				'description' => 'Rank Math SEO title and description.',
				'type'        => 'object',
				'context'     => array( 'edit' ),
			),
		);
		register_rest_field( 'page', 'wpa_rank_math', $seo_field );
		register_rest_field( 'page', 'cc_rank_math', $seo_field );
	},
	100
);
