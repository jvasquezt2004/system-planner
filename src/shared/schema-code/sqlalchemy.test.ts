import { describe, expect, test } from "bun:test";
import { awkwardNamesDesign, blogDesign, minimalDesign, typeCatalogDesign, vectorDesign } from "./fixtures";
import type { Design } from "../design";
import { generateSqlAlchemyModels } from "./sqlalchemy";

function generatedCode(design: Design): string {
	const result = generateSqlAlchemyModels(design);
	if (!result.ok) throw new Error(result.errors.join("; "));
	return result.code;
}

describe("SQLAlchemy schema code", () => {
	test("matches complete snapshots for every shared fixture", () => {
		expect(generatedCode(minimalDesign)).toMatchInlineSnapshot(`
		  "from sqlalchemy import BigInteger, Identity, Text
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


		  class Base(DeclarativeBase):
		      pass


		  class User(Base):
		      __tablename__ = "users"
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      email: Mapped[str] = mapped_column(Text(), unique=True)
		      display_name: Mapped[str | None] = mapped_column(Text())
		  "
		`);
		expect(generatedCode(blogDesign)).toMatchInlineSnapshot(`
		  "import enum
		  from datetime import date, datetime
		  from decimal import Decimal
		  from uuid import UUID

		  from sqlalchemy import (
		      ARRAY,
		      TIMESTAMP,
		      BigInteger,
		      Boolean,
		      Date,
		      ForeignKey,
		      Identity,
		      Index,
		      Numeric,
		      String,
		      Text,
		      UniqueConstraint,
		      column,
		      text,
		  )
		  from sqlalchemy.dialects.postgresql import ENUM, JSONB
		  from sqlalchemy.dialects.postgresql import UUID as PGUUID
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


		  class Base(DeclarativeBase):
		      pass


		  class UserRole(enum.Enum):
		      MEMBER = "member"
		      EDITOR = "editor"
		      ADMIN = "admin"


		  UserRoleType = ENUM(
		      UserRole,
		      name="user_role",
		      create_type=True,
		      values_callable=lambda members: [member.value for member in members],
		  )


		  class User(Base):
		      __tablename__ = "users"
		      __table_args__ = (
		          Index(
		              "users_created_at_idx",
		              column("created_at"),
		              postgresql_using="brin",
		              postgresql_with={"pages_per_range": 32},
		          ),
		      )
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      email: Mapped[str] = mapped_column(String(255), unique=True)
		      display_name: Mapped[str | None] = mapped_column(Text())
		      role: Mapped[UserRole] = mapped_column(
		          UserRoleType,
		          server_default=text("'member'"),
		      )
		      created_at: Mapped[datetime] = mapped_column(
		          TIMESTAMP(timezone=True),
		          server_default=text("CURRENT_TIMESTAMP"),
		      )
		      author_posts: Mapped[list["Post"]] = relationship(
		          "Post",
		          back_populates="author",
		          foreign_keys="[Post.author_id]",
		      )
		      editor_posts: Mapped[list["Post"]] = relationship(
		          "Post",
		          back_populates="editor",
		          foreign_keys="[Post.editor_id]",
		      )
		      profile: Mapped["Profile | None"] = relationship(
		          "Profile",
		          back_populates="user",
		          foreign_keys="[Profile.user_id]",
		          uselist=False,
		      )


		  class Profile(Base):
		      __tablename__ = "profiles"
		      __table_args__ = (UniqueConstraint("user_id", name="profiles_user_id_key"),)
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      user_id: Mapped[int] = mapped_column(
		          BigInteger(),
		          ForeignKey("users.id", name="profiles_user_id_fkey", ondelete="CASCADE"),
		      )
		      bio: Mapped[str | None] = mapped_column(Text())
		      birthday: Mapped[date | None] = mapped_column(Date())
		      user: Mapped["User"] = relationship(
		          "User",
		          back_populates="profile",
		          foreign_keys="[Profile.user_id]",
		          uselist=False,
		      )


		  class Post(Base):
		      __tablename__ = "posts"
		      __table_args__ = (
		          UniqueConstraint("author_id", "slug", name="posts_author_slug_key"),
		          Index(
		              "posts_author_id_created_at_idx",
		              column("author_id"),
		              column("created_at").desc().nulls_last(),
		              postgresql_using="btree",
		              postgresql_include=["title"],
		          ),
		          Index("posts_keywords_gin", column("keywords"), postgresql_using="gin"),
		          Index(
		              "posts_metadata_idx",
		              column("metadata"),
		              postgresql_using="gin",
		              postgresql_ops={"metadata": "jsonb_path_ops"},
		              postgresql_with={"fastupdate": False},
		          ),
		          Index("posts_slug_idx", column("slug"), postgresql_using="hash"),
		          Index(
		              "posts_title_editor_id_idx",
		              column("title"),
		              column("editor_id"),
		              unique=True,
		              postgresql_using="btree",
		              postgresql_nulls_not_distinct=True,
		          ),
		      )
		      id: Mapped[UUID] = mapped_column(
		          PGUUID(as_uuid=True),
		          primary_key=True,
		          server_default=text("gen_random_uuid()"),
		      )
		      author_id: Mapped[int] = mapped_column(
		          BigInteger(),
		          ForeignKey("users.id", name="posts_author_id_fkey", ondelete="CASCADE"),
		      )
		      editor_id: Mapped[int | None] = mapped_column(
		          BigInteger(),
		          ForeignKey("users.id", name="posts_editor_id_fkey", ondelete="SET NULL"),
		      )
		      title: Mapped[str] = mapped_column(Text())
		      slug: Mapped[str] = mapped_column(String(120))
		      body: Mapped[str | None] = mapped_column(Text())
		      keywords: Mapped[list[str] | None] = mapped_column(ARRAY(Text()))
		      published: Mapped[bool] = mapped_column(Boolean(), server_default=text("false"))
		      rating: Mapped[Decimal | None] = mapped_column(Numeric(3, 1))
		      metadata_: Mapped[dict] = mapped_column(
		          "metadata",
		          JSONB(),
		          server_default=text("JSONB '{}'"),
		      )
		      created_at: Mapped[datetime] = mapped_column(
		          TIMESTAMP(timezone=True),
		          server_default=text("CURRENT_TIMESTAMP"),
		      )
		      author: Mapped["User"] = relationship(
		          "User",
		          back_populates="author_posts",
		          foreign_keys="[Post.author_id]",
		          uselist=False,
		      )
		      editor: Mapped["User | None"] = relationship(
		          "User",
		          back_populates="editor_posts",
		          foreign_keys="[Post.editor_id]",
		          uselist=False,
		      )
		      comments: Mapped[list["Comment"]] = relationship(
		          "Comment",
		          back_populates="post",
		          foreign_keys="[Comment.post_id]",
		      )
		      post_tags: Mapped[list["PostTag"]] = relationship(
		          "PostTag",
		          back_populates="post",
		          foreign_keys="[PostTag.post_id]",
		      )
		      tags: Mapped[list["Tag"]] = relationship(
		          "Tag",
		          secondary="post_tags",
		          viewonly=True,
		      )


		  class Comment(Base):
		      __tablename__ = "comments"
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      post_id: Mapped[UUID] = mapped_column(
		          PGUUID(as_uuid=True),
		          ForeignKey(
		              "posts.id",
		              name="comments_post_id_fkey",
		              ondelete="CASCADE",
		              onupdate="CASCADE",
		          ),
		      )
		      parent_id: Mapped[int | None] = mapped_column(
		          BigInteger(),
		          ForeignKey("comments.id", name="comments_parent_id_fkey", ondelete="SET NULL"),
		      )
		      body: Mapped[str] = mapped_column(Text())
		      post: Mapped["Post"] = relationship(
		          "Post",
		          back_populates="comments",
		          foreign_keys="[Comment.post_id]",
		          uselist=False,
		      )
		      parent: Mapped["Comment | None"] = relationship(
		          "Comment",
		          back_populates="replies",
		          foreign_keys="[Comment.parent_id]",
		          remote_side="[Comment.id]",
		          uselist=False,
		      )
		      replies: Mapped[list["Comment"]] = relationship(
		          "Comment",
		          back_populates="parent",
		          foreign_keys="[Comment.parent_id]",
		      )


		  class Tag(Base):
		      __tablename__ = "tags"
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      name: Mapped[str] = mapped_column(String(64), unique=True)
		      post_tags: Mapped[list["PostTag"]] = relationship(
		          "PostTag",
		          back_populates="tag",
		          foreign_keys="[PostTag.tag_id]",
		      )
		      posts: Mapped[list["Post"]] = relationship(
		          "Post",
		          secondary="post_tags",
		          viewonly=True,
		      )


		  class PostTag(Base):
		      __tablename__ = "post_tags"
		      __table_args__ = (UniqueConstraint("post_id", "tag_id", name="post_tags_pair_key"),)
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      post_id: Mapped[UUID] = mapped_column(
		          PGUUID(as_uuid=True),
		          ForeignKey("posts.id", name="post_tags_post_id_fkey", ondelete="CASCADE"),
		      )
		      tag_id: Mapped[int] = mapped_column(
		          BigInteger(),
		          ForeignKey("tags.id", name="post_tags_tag_id_fkey", ondelete="RESTRICT"),
		      )
		      added_at: Mapped[datetime] = mapped_column(
		          TIMESTAMP(timezone=True),
		          server_default=text("CURRENT_TIMESTAMP"),
		      )
		      post: Mapped["Post"] = relationship(
		          "Post",
		          back_populates="post_tags",
		          foreign_keys="[PostTag.post_id]",
		          uselist=False,
		      )
		      tag: Mapped["Tag"] = relationship(
		          "Tag",
		          back_populates="post_tags",
		          foreign_keys="[PostTag.tag_id]",
		          uselist=False,
		      )
		  "
		`);
		expect(generatedCode(vectorDesign)).toMatchInlineSnapshot(`
		  "from pgvector.sqlalchemy import BIT as VectorBit
		  from pgvector.sqlalchemy import HALFVEC, SPARSEVEC, Vector
		  from sqlalchemy import BigInteger, Identity, Index, Text, column
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

		  # Install PostgreSQL's vector extension through a migration: CREATE EXTENSION IF NOT EXISTS vector;


		  class Base(DeclarativeBase):
		      pass


		  class Document(Base):
		      __tablename__ = "documents"
		      __table_args__ = (
		          Index(
		              "documents_embedding_idx",
		              column("embedding"),
		              postgresql_using="hnsw",
		              postgresql_ops={"embedding": "vector_cosine_ops"},
		              postgresql_with={"m": 16, "ef_construction": 64},
		          ),
		          Index(
		              "documents_summary_ivfflat",
		              column("summary_embedding"),
		              postgresql_using="ivfflat",
		              postgresql_ops={"summary_embedding": "halfvec_l2_ops"},
		              postgresql_with={"lists": 100},
		          ),
		          Index(
		              "documents_keywords_embedding_idx",
		              column("keywords_embedding"),
		              postgresql_using="hnsw",
		              postgresql_ops={"keywords_embedding": "sparsevec_ip_ops"},
		          ),
		          Index(
		              "documents_signature_idx",
		              column("signature"),
		              postgresql_using="hnsw",
		              postgresql_ops={"signature": "bit_hamming_ops"},
		          ),
		      )
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      content: Mapped[str] = mapped_column(Text())
		      embedding: Mapped[list[float]] = mapped_column(Vector(1536))
		      summary_embedding: Mapped[list[float] | None] = mapped_column(HALFVEC(768))
		      keywords_embedding: Mapped[object | None] = mapped_column(SPARSEVEC(30000))
		      signature: Mapped[str | None] = mapped_column(VectorBit(256))
		  "
		`);
		expect(generatedCode(typeCatalogDesign)).toMatchInlineSnapshot(`
		  "import enum
		  from datetime import date, datetime, time, timedelta
		  from decimal import Decimal
		  from uuid import UUID

		  from pgvector.sqlalchemy import BIT as VectorBit
		  from pgvector.sqlalchemy import HALFVEC, SPARSEVEC, Vector
		  from sqlalchemy import (
		      ARRAY,
		      CHAR,
		      DOUBLE_PRECISION,
		      REAL,
		      TIMESTAMP,
		      BigInteger,
		      Boolean,
		      Date,
		      Identity,
		      Integer,
		      Interval,
		      LargeBinary,
		      Numeric,
		      SmallInteger,
		      String,
		      Text,
		      Time,
		      text,
		  )
		  from sqlalchemy.dialects.postgresql import CIDR, ENUM, INET, JSON, JSONB, MACADDR, MONEY
		  from sqlalchemy.dialects.postgresql import UUID as PGUUID
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

		  # Install PostgreSQL's vector extension through a migration: CREATE EXTENSION IF NOT EXISTS vector;


		  class Base(DeclarativeBase):
		      pass


		  class Mood(enum.Enum):
		      HAPPY = "happy"
		      SAD = "sad"
		      IN_BETWEEN = "in-between"


		  MoodType = ENUM(
		      Mood,
		      name="mood",
		      create_type=True,
		      values_callable=lambda members: [member.value for member in members],
		  )


		  class TypeCatalog(Base):
		      __tablename__ = "type_catalog"
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      integer_value: Mapped[int | None] = mapped_column(Integer())
		      smallint_value: Mapped[int | None] = mapped_column(SmallInteger())
		      text_value: Mapped[str | None] = mapped_column(Text())
		      varchar_value: Mapped[str | None] = mapped_column(String(40))
		      varchar_unbounded: Mapped[str | None] = mapped_column(String())
		      char_value: Mapped[str | None] = mapped_column(CHAR(2))
		      uuid_value: Mapped[UUID | None] = mapped_column(PGUUID(as_uuid=True))
		      boolean_value: Mapped[bool | None] = mapped_column(Boolean())
		      numeric_value: Mapped[Decimal | None] = mapped_column(Numeric(None))
		      money_amount: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
		      real_value: Mapped[float | None] = mapped_column(REAL())
		      double_value: Mapped[float | None] = mapped_column(DOUBLE_PRECISION())
		      date_value: Mapped[date | None] = mapped_column(Date())
		      time_value: Mapped[time | None] = mapped_column(Time(timezone=False))
		      timetz_value: Mapped[time | None] = mapped_column(Time(timezone=True))
		      timestamp_value: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=False))
		      timestamptz_value: Mapped[datetime | None] = mapped_column(TIMESTAMP(timezone=True))
		      interval_value: Mapped[timedelta | None] = mapped_column(Interval())
		      json_value: Mapped[dict | None] = mapped_column(JSON())
		      jsonb_value: Mapped[dict | None] = mapped_column(JSONB())
		      bytea_value: Mapped[bytes | None] = mapped_column(LargeBinary())
		      inet_value: Mapped[str | None] = mapped_column(INET())
		      cidr_value: Mapped[str | None] = mapped_column(CIDR())
		      macaddr_value: Mapped[str | None] = mapped_column(MACADDR())
		      money_value: Mapped[Decimal | None] = mapped_column(MONEY())
		      bit_value: Mapped[str | None] = mapped_column(VectorBit(8))
		      vector_value: Mapped[list[float] | None] = mapped_column(Vector(3))
		      halfvec_value: Mapped[list[float] | None] = mapped_column(HALFVEC(3))
		      sparsevec_value: Mapped[object | None] = mapped_column(SPARSEVEC(3))
		      mood_value: Mapped[Mood | None] = mapped_column(MoodType)
		      mood_history: Mapped[list[Mood] | None] = mapped_column(ARRAY(MoodType))
		      integer_list: Mapped[list[int] | None] = mapped_column(ARRAY(Integer()))
		      uuid_list: Mapped[list[UUID] | None] = mapped_column(ARRAY(PGUUID(as_uuid=True)))
		      integer_default: Mapped[int] = mapped_column(Integer(), server_default=text("42"))
		      numeric_default: Mapped[Decimal] = mapped_column(
		          Numeric(None),
		          server_default=text("1.50"),
		      )
		      text_default: Mapped[str] = mapped_column(
		          Text(),
		          server_default=text("'it''s \\"quoted\\"'"),
		      )
		      date_default: Mapped[date] = mapped_column(
		          Date(),
		          server_default=text("DATE '2024-01-31'"),
		      )
		  "
		`);
		expect(generatedCode(awkwardNamesDesign)).toMatchInlineSnapshot(`
		  "import enum

		  from sqlalchemy import BigInteger, ForeignKey, Identity, Integer, Text
		  from sqlalchemy.dialects.postgresql import ENUM
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


		  class Base(DeclarativeBase):
		      pass


		  class OrderStatus(enum.Enum):
		      NEW = "new"
		      IN_PROGRESS = "in progress"
		      _2ND_TRY = "2nd try"
		      NONE = "None"


		  OrderStatusType = ENUM(
		      OrderStatus,
		      name="order-status",
		      create_type=True,
		      values_callable=lambda members: [member.value for member in members],
		  )


		  class Class(Base):
		      __tablename__ = "class"
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      from_: Mapped[str] = mapped_column("from", Text())
		      import_: Mapped[str | None] = mapped_column("import", Text())
		      type: Mapped[str | None] = mapped_column(Text())
		      _2fa_secret: Mapped[str | None] = mapped_column("2fa_secret", Text())
		      display_name: Mapped[str | None] = mapped_column("Display Name", Text())
		      user_id: Mapped[int | None] = mapped_column(Integer())
		      user_id_2: Mapped[int | None] = mapped_column("userId", Integer())
		      order_items: Mapped[list["OrderItem"]] = relationship(
		          "OrderItem",
		          back_populates="class_",
		          foreign_keys="[OrderItem.class_id]",
		      )


		  class OrderItem(Base):
		      __tablename__ = "order_items"
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		      class_id: Mapped[int] = mapped_column(
		          BigInteger(),
		          ForeignKey("class.id", name="order_items_class_id_fkey"),
		      )
		      status: Mapped[OrderStatus] = mapped_column(OrderStatusType)
		      class_: Mapped["Class"] = relationship(
		          "Class",
		          back_populates="order_items",
		          foreign_keys="[OrderItem.class_id]",
		          uselist=False,
		      )


		  class OrderItem_2(Base):
		      __tablename__ = "OrderItems"
		      id: Mapped[int] = mapped_column(
		          BigInteger(),
		          Identity(always=True),
		          primary_key=True,
		      )
		  "
		`);
	});

	test("maps relationship shapes and generated constraint names", () => {
		const result = generateSqlAlchemyModels(blogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.code).toContain("ForeignKey(\"users.id\", name=\"posts_author_id_fkey\"");
		expect(result.code).toContain("remote_side=\"[Comment.id]\"");
		expect(result.code).toContain("uselist=False");
		expect(result.code).toContain("UniqueConstraint(\"post_id\", \"tag_id\"");
		expect(result.code).toContain("Mapped[list[\"Post\"]] = relationship(");
		expect(result.code).toContain("foreign_keys=\"[Post.author_id]\"");
		expect(result.code).toContain("foreign_keys=\"[Post.editor_id]\"");
		expect(result.code).toContain("class PostTag(Base):");
		expect(result.code).toContain("back_populates=");
		expect(result.code).toContain("secondary=\"post_tags\"");
		expect(result.code).toContain("author_posts: Mapped[list[\"Post\"]]");
		expect(result.code).toContain("editor_posts: Mapped[list[\"Post\"]]");
		expect(result.code).toContain("replies: Mapped[list[\"Comment\"]]");
	});

	test("maps the full PostgreSQL type catalog and defaults", () => {
		const result = generateSqlAlchemyModels(typeCatalogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const fragment of ["ARRAY(Integer())", "ARRAY(PGUUID(as_uuid=True))", "Numeric(12, 2)", "TIMESTAMP(timezone=True)", "JSONB()", "MoodType = ENUM(", "server_default=text(\"DATE '"]) {
			expect(result.code).toContain(fragment);
		}
	});

	test("uses collision-safe Python names while retaining database names", () => {
		const result = generateSqlAlchemyModels(awkwardNamesDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const fragment of ["class Class(Base):", "mapped_column(\"from\"", "mapped_column(\"2fa_secret\"", "mapped_column(\"userId\""]) {
			expect(result.code).toContain(fragment);
		}
	});

	test("preserves index methods, ordering, opclasses, INCLUDE and storage", () => {
		const result = generateSqlAlchemyModels(blogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const fragment of ["postgresql_using=\"gin\"", ".desc().nulls_last()", "postgresql_ops={\"metadata\": \"jsonb_path_ops\"}", "postgresql_include=[\"title\"]", "postgresql_nulls_not_distinct=True", "pages_per_range", "fastupdate"]) {
			expect(result.code).toContain(fragment);
		}
	});

	test("maps pgvector types and vector indexes", () => {
		const result = generateSqlAlchemyModels(vectorDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const fragment of ["Vector(1536)", "HALFVEC(768)", "SPARSEVEC(30000)", "VectorBit(256)", "postgresql_using=\"hnsw\"", "postgresql_ops={\"embedding\": \"vector_cosine_ops\"}", "postgresql_ops={\"summary_embedding\": \"halfvec_l2_ops\"}"]) {
			expect(result.code).toContain(fragment);
		}
		expect(result.code).toContain("CREATE EXTENSION IF NOT EXISTS vector");
	});

	test("generates stable single-table output", () => {
		expect(generateSqlAlchemyModels(minimalDesign)).toEqual(generateSqlAlchemyModels(minimalDesign));
	});
});
