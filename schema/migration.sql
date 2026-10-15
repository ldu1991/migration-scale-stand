CREATE TABLE IF NOT EXISTS schema_migrations (
  id         text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION cms_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION cms_prevent_hierarchy_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  max_depth constant integer := 1000;
  depth     integer := 0;
  walk_id   bigint;
BEGIN
  IF NEW.parent_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.parent_id = NEW.id THEN
    RAISE EXCEPTION '%: row % cannot be its own parent', TG_TABLE_NAME, NEW.id;
  END IF;

  walk_id := NEW.parent_id;
  WHILE walk_id IS NOT NULL LOOP
    IF walk_id = NEW.id THEN
      RAISE EXCEPTION '%: hierarchy cycle detected for id %', TG_TABLE_NAME, NEW.id;
    END IF;

    depth := depth + 1;
    IF depth > max_depth THEN
      RAISE EXCEPTION '%: hierarchy above id % exceeds % levels (corrupt data?)',
        TG_TABLE_NAME, NEW.id, max_depth;
    END IF;

    EXECUTE format(
      'SELECT parent_id FROM %I.%I WHERE id = $1 FOR SHARE',
      TG_TABLE_SCHEMA, TG_TABLE_NAME
    )
      INTO walk_id
      USING walk_id;
  END LOOP;

  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email         text NOT NULL,
  password_hash text NOT NULL,
  name          text,
  avatar        jsonb,
  role          text NOT NULL DEFAULT 'subscriber',
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'banned')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_id_positive CHECK (id > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (lower(email));
DROP TRIGGER IF EXISTS users_set_updated_at ON users;
CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION cms_set_updated_at();

CREATE TABLE IF NOT EXISTS collections (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type          text NOT NULL,
  status        text NOT NULL DEFAULT 'draft' CHECK (status IN ('published', 'draft', 'trash')),
  slug          text NOT NULL,
  title         text NOT NULL,
  fields        jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocks        jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_id     bigint REFERENCES users (id) ON DELETE SET NULL,
  parent_id     bigint REFERENCES collections (id) ON DELETE SET NULL,
  menu_order    integer NOT NULL DEFAULT 0,
  password_hash text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  published_at  timestamptz,
  CONSTRAINT collections_id_positive CHECK (id > 0),
  CONSTRAINT collections_parent_not_self CHECK (parent_id IS DISTINCT FROM id),
  CONSTRAINT collections_published_at_present
    CHECK (status <> 'published' OR published_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS collections_type_parent_slug_unique
  ON collections (type, parent_id, slug) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS collections_type_status_published_idx
  ON collections (type, status, published_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS collections_author_id_idx ON collections (author_id);
CREATE INDEX IF NOT EXISTS collections_parent_id_idx ON collections (parent_id);
CREATE INDEX IF NOT EXISTS collections_fields_gin
  ON collections USING GIN (fields jsonb_path_ops);
DROP TRIGGER IF EXISTS collections_set_updated_at ON collections;
CREATE TRIGGER collections_set_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW
  EXECUTE FUNCTION cms_set_updated_at();
DROP TRIGGER IF EXISTS collections_prevent_hierarchy_cycle ON collections;
CREATE TRIGGER collections_prevent_hierarchy_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON collections
  FOR EACH ROW
  EXECUTE FUNCTION cms_prevent_hierarchy_cycle();

CREATE TABLE IF NOT EXISTS collection_meta (
  collection_id bigint NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  key           text NOT NULL,
  value         jsonb,
  PRIMARY KEY (collection_id, key)
);

CREATE TABLE IF NOT EXISTS collection_revisions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  collection_id bigint NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  author_id     bigint REFERENCES users (id) ON DELETE SET NULL,
  data          jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collection_revisions_id_positive CHECK (id > 0)
);
CREATE INDEX IF NOT EXISTS collection_revisions_collection_created_idx
  ON collection_revisions (collection_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS media (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  filename        text NOT NULL,
  mime_type       text NOT NULL,
  filesize        bigint NOT NULL CHECK (filesize >= 0),
  width           integer CHECK (width > 0),
  height          integer CHECK (height > 0),
  alt             text,
  caption         text,
  uploaded_by     bigint REFERENCES users (id) ON DELETE SET NULL,
  variants        jsonb NOT NULL DEFAULT '[]'::jsonb,
  variants_status text NOT NULL DEFAULT 'none' CHECK (variants_status IN ('none', 'pending', 'ready', 'failed')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT media_id_positive CHECK (id > 0)
);
CREATE UNIQUE INDEX IF NOT EXISTS media_filename_unique ON media (filename);
CREATE INDEX IF NOT EXISTS media_uploaded_by_idx ON media (uploaded_by);
DROP TRIGGER IF EXISTS media_set_updated_at ON media;
CREATE TRIGGER media_set_updated_at
  BEFORE UPDATE ON media
  FOR EACH ROW
  EXECUTE FUNCTION cms_set_updated_at();

CREATE TABLE IF NOT EXISTS dictionaries (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug       text NOT NULL,
  title      text NOT NULL,
  type       text NOT NULL,
  fields     jsonb NOT NULL DEFAULT '{}'::jsonb,
  parent_id  bigint REFERENCES dictionaries (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dictionaries_id_positive CHECK (id > 0),
  CONSTRAINT dictionaries_parent_not_self CHECK (parent_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX IF NOT EXISTS dictionaries_type_parent_slug_unique
  ON dictionaries (type, parent_id, slug) NULLS NOT DISTINCT;
CREATE INDEX IF NOT EXISTS dictionaries_parent_id_idx ON dictionaries (parent_id);
CREATE INDEX IF NOT EXISTS dictionaries_type_parent_idx ON dictionaries (type, parent_id);
CREATE INDEX IF NOT EXISTS dictionaries_fields_gin
  ON dictionaries USING GIN (fields jsonb_path_ops);
DROP TRIGGER IF EXISTS dictionaries_set_updated_at ON dictionaries;
CREATE TRIGGER dictionaries_set_updated_at
  BEFORE UPDATE ON dictionaries
  FOR EACH ROW
  EXECUTE FUNCTION cms_set_updated_at();
DROP TRIGGER IF EXISTS dictionaries_prevent_hierarchy_cycle ON dictionaries;
CREATE TRIGGER dictionaries_prevent_hierarchy_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON dictionaries
  FOR EACH ROW
  EXECUTE FUNCTION cms_prevent_hierarchy_cycle();

CREATE TABLE IF NOT EXISTS collection_dictionaries (
  collection_id bigint NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
  dictionary_id bigint NOT NULL REFERENCES dictionaries (id) ON DELETE CASCADE,
  PRIMARY KEY (collection_id, dictionary_id)
);
CREATE INDEX IF NOT EXISTS collection_dictionaries_dictionary_idx
  ON collection_dictionaries (dictionary_id);

CREATE TABLE IF NOT EXISTS options (
  key   text PRIMARY KEY,
  value jsonb
);
