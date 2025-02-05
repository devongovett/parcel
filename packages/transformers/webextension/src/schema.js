// @flow strict-local
import type {SchemaEntity} from '@parcel/utils';

const validateVersion = (ver: string): ?string => {
  const parts = ver.split('.', 5);
  if (parts.length == 5) return 'Extension versions to have at most three dots';
  if (
    parts.every(
      part => part.length != 0 && Number(part[0]) >= 0 && Number(part) < 65536,
    )
  )
    return;
  return 'Extension versions must be dot-separated integers between 0 and 65535';
};

const string: SchemaEntity = {type: 'string'};
const boolean: SchemaEntity = {type: 'boolean'};

const icons: SchemaEntity = {
  type: 'object',
  properties: {},
  additionalProperties: string,
};

const actionProps = {
  // FF only
  browser_style: boolean,
  chrome_style: boolean,
  // You can also have a raw string, but not in Edge, apparently...
  default_icon: {
    oneOf: [icons, string],
  },
  default_popup: string,
  default_title: string,
};

const arrStr = {
  type: 'array',
  items: string,
};

const browserAction = {
  type: 'object',
  properties: {
    ...actionProps,
    // rest are FF only
    default_area: {
      type: 'string',
      enum: ['navbar', 'menupanel', 'tabstrip', 'personaltoolbar'],
    },
    theme_icons: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          light: string,
          dark: string,
          size: {type: 'number'},
        },
        additionalProperties: false,
        required: ['light', 'dark', 'size'],
      },
    },
  },
  additionalProperties: false,
};

const warBase = {
  type: 'object',
  properties: {
    resources: arrStr,
    matches: arrStr,
    extension_ids: arrStr,
    use_dynamic_url: boolean,
  },
  additionalProperties: false,
};

const mv2Background = {
  type: 'object',
  properties: {
    scripts: arrStr,
    page: string,
    persistent: boolean,
    type: {
      type: 'string',
      enum: ['classic', 'module'],
    },
  },
  additionalProperties: false,
};

const commonProps = {
  $schema: string,
  name: string,
  version: {
    type: 'string',
    __validate: validateVersion,
  },
  default_locale: string,
  description: string,
  icons,
  author: string,
  browser_specific_settings: {
    type: 'object',
    properties: {},
    additionalProperties: {
      type: 'object',
      properties: {},
    },
  },
  chrome_settings_overrides: {
    type: 'object',
    properties: {
      homepage: string,
      search_provider: {
        type: 'object',
        properties: {
          name: string,
          keyword: string,
          favicon_url: string,
          search_url: string,
          encoding: string,
          suggest_url: string,
          image_url: string,
          instant_url: string,
          search_url_post_params: string,
          suggest_url_post_params: string,
          image_url_post_params: string,
          instant_url_post_params: string,
          alternate_urls: arrStr,
          prepopulated_id: {type: 'number'},
          is_default: boolean,
        },
        additionalProperties: false,
        required: ['name', 'search_url'],
      },
      startup_pages: arrStr,
    },
    additionalProperties: false,
  },
  chrome_url_overrides: {
    type: 'object',
    properties: {
      bookmarks: string,
      history: string,
      newtab: string,
    },
    additionalProperties: false,
  },
  commands: ({
    type: 'object',
    properties: {},
    additionalProperties: {
      type: 'object',
      properties: {
        suggested_key: {
          type: 'object',
          properties: {
            default: string,
            mac: string,
            linux: string,
            windows: string,
            chromeos: string,
            android: string,
            ios: string,
          },
          additionalProperties: false,
        },
        description: string,
      },
      additionalProperties: false,
    },
  }: SchemaEntity),
  content_scripts: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        matches: arrStr,
        css: arrStr,
        js: arrStr,
        match_about_blank: boolean,
        exclude_matches: arrStr,
        include_globs: arrStr,
        exclude_globs: arrStr,
        run_at: {
          type: 'string',
          enum: ['document_idle', 'document_start', 'document_end'],
        },
        all_frames: boolean,
        world: {
          type: 'string',
          enum: ['ISOLATED', 'MAIN'],
        },
      },
      additionalProperties: false,
      required: ['matches'],
    },
  },
  declarative_net_request: ({
    type: 'object',
    properties: {
      rule_resources: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: string,
            enabled: boolean,
            path: string,
          },
          additionalProperties: false,
          required: ['id', 'enabled', 'path'],
        },
      },
    },
    additionalProperties: false,
    required: ['rule_resources'],
  }: SchemaEntity),
  devtools_page: string,
  // looks to be FF only
  dictionaries: ({
    type: 'object',
    properties: {},
    additionalProperties: string,
  }: SchemaEntity),
  externally_connectable: {
    type: 'object',
    properties: {
      ids: arrStr,
      matches: arrStr,
      accept_tls_channel_id: boolean,
    },
    additionalProperties: false,
  },
  // These next two are where it gets a bit Chrome-y
  // (we don't include all because some have next to no actual use)
  file_browser_handlers: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: string,
        default_title: string,
        file_filters: arrStr,
      },
      additionalProperties: false,
      required: ['id', 'default_title', 'file_filters'],
    },
  },
  file_system_provider_capabilities: {
    type: 'object',
    properties: {
      configurable: boolean,
      multiple_mounts: boolean,
      watchable: boolean,
      source: {
        type: 'string',
        enum: ['file', 'device', 'network'],
      },
    },
    additionalProperties: false,
    required: ['source'],
  },
  homepage_url: string,
  incognito: {
    type: 'string',
    enum: ['spanning', 'split', 'not_allowed'],
  },
  key: string,
  minimum_chrome_version: {
    type: 'string',
    __validate: validateVersion,
  },
  // No NaCl modules because deprecated
  oauth2: {
    type: 'object',
    properties: {
      client_id: string,
      scopes: arrStr,
    },
    additionalProperties: false,
  },
  offline_enabled: boolean,
  omnibox: ({
    type: 'object',
    properties: {},
    additionalProperties: string,
  }: SchemaEntity),
  optional_host_permissions: arrStr,
  optional_permissions: arrStr,
  // options_page is deprecated
  options_ui: {
    type: 'object',
    properties: {
      browser_style: boolean,
      chrome_style: boolean,
      open_in_tab: boolean,
      page: string,
    },
    additionalProperties: false,
    required: ['page'],
  },
  permissions: arrStr,
  // FF only, but has some use
  protocol_handlers: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        protocol: string,
        name: string,
        uriTemplate: string,
      },
      additionalProperties: false,
      required: ['protocol', 'name', 'uriTemplate'],
    },
  },
  // Chrome only
  requirements: {
    type: 'object',
    properties: {
      '3D': {
        type: 'object',
        properties: {
          features: arrStr,
        },
        additionalProperties: false,
      },
    },
  },
  short_name: string,
  // FF only, but has some use
  sidebar_action: {
    type: 'object',
    properties: {
      browser_style: actionProps.browser_style,
      default_icon: actionProps.default_icon,
      default_panel: string,
      default_title: string,
      open_at_install: boolean,
    },
    additionalProperties: false,
    required: ['default_panel'],
  },
  storage: {
    type: 'object',
    properties: {
      managed_schema: string,
    },
    additionalProperties: false,
  },
  theme: {
    type: 'object',
    properties: {
      images: {
        type: 'object',
        properties: {
          theme_frame: string,
          additional_backgrounds: arrStr,
        },
        additionalProperties: false,
      },
      colors: {
        type: 'object',
        properties: {
          bookmark_text: string,
          button_background_active: string,
          button_background_hover: string,
          icons: string,
          icons_attention: string,
          frame: string,
          frame_inactive: string,
          ntp_background: string,
          ntp_text: string,
          popup: string,
          popup_border: string,
          popup_highlight: string,
          popup_highlight_text: string,
          popup_text: string,
          sidebar: string,
          sidebar_border: string,
          sidebar_highlight: string,
          sidebar_highlight_text: string,
          sidebar_text: string,
          tab_background_separator: string,
          tab_background_text: string,
          tab_line: string,
          tab_loading: string,
          tab_selected: string,
          tab_text: string,
          toolbar: string,
          toolbar_bottom_separator: string,
          toolbar_field: string,
          toolbar_field_border: string,
          toolbar_field_border_focus: string,
          toolbar_field_focus: string,
          toolbar_field_highlight: string,
          toolbar_field_highlight_text: string,
          toolbar_field_separator: string,
          toolbar_field_text: string,
          toolbar_field_text_focus: string,
          toolbar_text: string,
          toolbar_top_separator: string,
          toolbar_vertical_separator: string,
        },
        additionalProperties: false,
      },
      properties: {
        type: 'object',
        properties: {
          additional_backgrounds_alignment: arrStr,
          additional_backgrounds_tiling: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['no-repeat', 'repeat', 'repeat-x', 'repeat-y'],
            },
          },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
    required: ['colors'],
  },
  tts_engine: {
    type: 'object',
    properties: {
      voices: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            voice_name: string,
            lang: string,
            event_type: {
              type: 'string',
              enum: ['start', 'word', 'sentence', 'marker', 'end', 'error'],
            },
          },
          additionalProperties: false,
          required: ['voice_name', 'event_type'],
        },
      },
    },
    additionalProperties: false,
  },
  update_url: string,
  user_scripts: {
    type: 'object',
    properties: {
      api_script: string,
    },
    additionalProperties: false,
  },
  version_name: string,
};

export const MV3Schema = ({
  type: 'object',
  properties: {
    ...commonProps,
    manifest_version: {
      type: 'number',
      enum: [3],
    },
    action: browserAction,
    background: {
      oneOf: [
        {
          type: 'object',
          properties: {
            service_worker: string,
            type: {
              type: 'string',
              enum: ['classic', 'module'],
            },
            // to support both Chrome and Firefox
            scripts: arrStr,
            page: string,
            persistent: boolean,
          },
          additionalProperties: false,
          required: ['service_worker'],
        },
        mv2Background,
      ], // for Firefox
    },
    content_security_policy: {
      type: 'object',
      properties: {
        extension_pages: string,
        sandbox: string,
      },
      additionalProperties: false,
    },
    host_permissions: arrStr,
    sandbox: {
      type: 'object',
      properties: {
        pages: arrStr,
      },
      additionalProperties: false,
    },
    side_panel: {
      type: 'object',
      properties: {
        default_path: string,
      },
      additionalProperties: false,
    },
    web_accessible_resources: {
      type: 'array',
      items: {
        oneOf: [
          {
            ...warBase,
            required: ['resources', 'matches'],
          },
          {
            ...warBase,
            required: ['resources', 'extension_ids'],
          },
        ],
      },
    },
  },
  required: ['manifest_version', 'name', 'version'],
}: SchemaEntity);

export const MV2Schema = ({
  type: 'object',
  properties: {
    ...commonProps,
    manifest_version: {
      type: 'number',
      enum: [2],
    },
    background: mv2Background,
    browser_action: browserAction,
    content_security_policy: string,
    page_action: {
      type: 'object',
      properties: {
        ...actionProps,
        // rest are FF only
        hide_matches: arrStr,
        show_matches: arrStr,
        pinned: boolean,
      },
      additionalProperties: false,
    },
    sandbox: {
      type: 'object',
      properties: {
        pages: arrStr,
        content_security_policy: string,
      },
      additionalProperties: false,
    },
    web_accessible_resources: arrStr,
  },
  required: ['manifest_version', 'name', 'version'],
}: SchemaEntity);

export const VersionSchema = ({
  type: 'object',
  properties: {
    $schema: string,
    manifest_version: {
      type: 'number',
      enum: [2, 3],
    },
  },
  required: ['manifest_version'],
}: SchemaEntity);
