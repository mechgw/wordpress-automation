<?php
/**
 * Atrapy WordPressa i Forminatora do wykonania mostu zleceń (#195) w prawdziwym PHP.
 *
 * Kształt danych jak w Forminatorze 1.57.x (sprawdzony w źródle wtyczki, 2026-09-26):
 * - get_form_fields() zwraca obiekty, których to_array() to element_id plus ustawienia
 *   pola z kreatora, w tym options = [ { label, value, key, error, default } ];
 * - get_entries() zwraca obiekty z entry_id, date_created_sql (surowa data z bazy),
 *   time_created (tekst do wyświetlania) i meta_data[klucz] = { id, value };
 * - pod kluczem pola wyboru save_entry_fields() zapisuje ETYKIETĘ opcji
 *   (replace_values_to_labels), a wysłaną wartość — w meta_data['_forminator_choice_values'].
 *
 * Wywołanie: php forminator-harness.php <fixture.json> <snippet.php>
 * Wynik (JSON): { route, reads, response } albo { error, status, message, reads }.
 */

class WP_Error {
	public $code;
	public $message;
	public $data;

	public function __construct( $code, $message, $data = array() ) {
		$this->code    = $code;
		$this->message = $message;
		$this->data    = $data;
	}
}

class WP_REST_Request {
	private $params;

	public function __construct( $params ) {
		$this->params = $params;
	}

	public function get_param( $key ) {
		return isset( $this->params[ $key ] ) ? $this->params[ $key ] : null;
	}
}

class Forminator_Form_Field_Model {
	private $slug;
	private $raw;

	public function __construct( $slug, $raw ) {
		$this->slug = $slug;
		$this->raw  = $raw;
	}

	public function to_array() {
		$data = array(
			'id'           => $this->slug,
			'element_id'   => $this->slug,
			'form_id'      => 0,
			'parent_group' => '',
		);
		return array_merge( $data, $this->raw );
	}
}

class Forminator_API {
	public static $fixture;
	/** Liczba odczytów zgłoszeń: tryb audytu mapowania nie może ich robić. */
	public static $reads = 0;

	public static function get_form_fields( $id ) {
		$fields = array();
		foreach ( self::$fixture['fields'] as $slug => $raw ) {
			$fields[] = new Forminator_Form_Field_Model( $slug, $raw );
		}
		return $fields;
	}

	public static function count_entries( $id ) {
		self::$reads++;
		return count( self::$fixture['entries'] );
	}

	public static function get_entries( $id, $per_page, $page ) {
		self::$reads++;
		$out = array();
		foreach ( array_slice( self::$fixture['entries'], ( $page - 1 ) * $per_page, $per_page ) as $entry ) {
			$out[] = (object) $entry;
		}
		return $out;
	}
}

function is_wp_error( $thing ) {
	return $thing instanceof WP_Error;
}

function add_action( $hook, $callback ) {
	$callback();
}

/** Trasy zarejestrowane przez snippet: klucz to namespace + ścieżka. */
class Harness_Routes {
	public static $routes = array();
}

function register_rest_route( $route_namespace, $route, $args ) {
	Harness_Routes::$routes[ $route_namespace . $route ] = $args;
}

function current_user_can( $capability ) {
	return true;
}

function rest_ensure_response( $data ) {
	return $data;
}

function absint( $value ) {
	return abs( (int) $value );
}

function wp_parse_url( $url, $component = -1 ) {
	return parse_url( $url, $component );
}

// Jak w WordPressie: najpierw script/style razem z treścią, potem znaczniki, na końcu trim.
function wp_strip_all_tags( $text ) {
	$text = preg_replace( '@<(script|style)[^>]*?>.*?</\\1>@si', '', (string) $text );
	return trim( strip_tags( $text ) );
}

function sanitize_text_field( $text ) {
	return trim( preg_replace( '/[\r\n\t ]+/', ' ', wp_strip_all_tags( $text ) ) );
}

$fixture                 = json_decode( file_get_contents( $argv[1] ), true );
Forminator_API::$fixture = $fixture;
require $argv[2];

$route_key = array_key_first( Harness_Routes::$routes );
$route     = Harness_Routes::$routes[ $route_key ];
$result    = call_user_func( $route['callback'], new WP_REST_Request( isset( $fixture['params'] ) ? $fixture['params'] : array() ) );
$output    = is_wp_error( $result )
	? array( 'error' => $result->code, 'status' => $result->data['status'], 'message' => $result->message, 'reads' => Forminator_API::$reads )
	: array( 'route' => $route_key, 'reads' => Forminator_API::$reads, 'response' => $result );
echo json_encode( $output, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
