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
		  "from __future__ import annotations

		  import enum
		  from datetime import date, datetime, time, timedelta
		  from decimal import Decimal
		  from uuid import UUID

		  from sqlalchemy import (
		      ARRAY, BigInteger, Boolean, CHAR, Date, DOUBLE_PRECISION, ForeignKey, Identity, Index, Integer,
		      Interval, LargeBinary, Numeric, REAL, SmallInteger, String, Text, Time, TIMESTAMP, UniqueConstraint,
		      text,
		  )
		  from sqlalchemy.dialects.postgresql import CIDR, ENUM, INET, JSONB, MACADDR, MONEY, UUID as PGUUID, JSON
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


		  class Base(DeclarativeBase):
		      pass

		  class Users(Base):
		      __tablename__ = "users"
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      email: Mapped[str] = mapped_column("email", Text(), unique=True, nullable=False)
		      display_name: Mapped[str | None] = mapped_column("display_name", Text(), nullable=True)
		  "
		`);
		expect(generatedCode(blogDesign)).toMatchInlineSnapshot(`
		  "from __future__ import annotations

		  import enum
		  from datetime import date, datetime, time, timedelta
		  from decimal import Decimal
		  from uuid import UUID

		  from sqlalchemy import (
		      ARRAY, BigInteger, Boolean, CHAR, Date, DOUBLE_PRECISION, ForeignKey, Identity, Index, Integer,
		      Interval, LargeBinary, Numeric, REAL, SmallInteger, String, Text, Time, TIMESTAMP, UniqueConstraint,
		      text,
		  )
		  from sqlalchemy.dialects.postgresql import CIDR, ENUM, INET, JSONB, MACADDR, MONEY, UUID as PGUUID, JSON
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


		  class Base(DeclarativeBase):
		      pass

		  class UserRole(enum.Enum):
		      MEMBER = "member"
		      EDITOR = "editor"
		      ADMIN = "admin"

		  UserRoleType = ENUM(UserRole, name="user_role", create_type=True, values_callable=lambda members: [member.value for member in members])

		  class Users(Base):
		      __tablename__ = "users"
		      __table_args__ = (
		          Index("users_created_at_idx", text("\\"created_at\\""), unique=False, postgresql_using="brin", postgresql_with={"pages_per_range": 32}),
		      )
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      email: Mapped[str] = mapped_column("email", String(255), unique=True, nullable=False)
		      display_name: Mapped[str | None] = mapped_column("display_name", Text(), nullable=True)
		      role: Mapped[UserRole] = mapped_column("role", UserRoleType, server_default=text("'member'"), nullable=False)
		      created_at: Mapped[datetime] = mapped_column("created_at", TIMESTAMP(timezone=True), server_default=text("CURRENT_TIMESTAMP"), nullable=False)
		      posts_author_id_items: Mapped[list[Posts]] = relationship("Posts", back_populates="users_author_id", foreign_keys="[Posts.author_id]")
		      posts_editor_id_items: Mapped[list[Posts]] = relationship("Posts", back_populates="users_editor_id", foreign_keys="[Posts.editor_id]")
		      profiles_user_id_items: Mapped[Profiles | None] = relationship("Profiles", back_populates="users_user_id", foreign_keys="[Profiles.user_id]", uselist=False)

		  class Profiles(Base):
		      __tablename__ = "profiles"
		      __table_args__ = (
		          UniqueConstraint("user_id", name="profiles_user_id_key"),
		      )
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      user_id: Mapped[int] = mapped_column("user_id", BigInteger(), ForeignKey("users.id", name="profiles_user_id_fkey", ondelete="CASCADE", onupdate="NO ACTION"), nullable=False)
		      bio: Mapped[str | None] = mapped_column("bio", Text(), nullable=True)
		      birthday: Mapped[date | None] = mapped_column("birthday", Date(), nullable=True)
		      users_user_id: Mapped[Users] = relationship("Users", back_populates="profiles_user_id_items", foreign_keys="[Profiles.user_id]", uselist=False)

		  class Posts(Base):
		      __tablename__ = "posts"
		      __table_args__ = (
		          UniqueConstraint("author_id", "slug", name="posts_author_slug_key", postgresql_nulls_not_distinct=False),
		          Index("posts_author_id_created_at_idx", text("\\"author_id\\""), text("\\"created_at\\" DESC NULLS LAST"), unique=False, postgresql_using="btree", postgresql_include=["title"]),
		          Index("posts_keywords_gin", text("\\"keywords\\""), unique=False, postgresql_using="gin"),
		          Index("posts_metadata_idx", text("\\"metadata\\" jsonb_path_ops"), unique=False, postgresql_using="gin", postgresql_with={"fastupdate": False}),
		          Index("posts_slug_idx", text("\\"slug\\""), unique=False, postgresql_using="hash"),
		          Index("posts_title_editor_id_idx", text("\\"title\\""), text("\\"editor_id\\""), unique=True, postgresql_using="btree", postgresql_nulls_not_distinct=True),
		      )
		      id: Mapped[UUID] = mapped_column("id", PGUUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
		      author_id: Mapped[int] = mapped_column("author_id", BigInteger(), ForeignKey("users.id", name="posts_author_id_fkey", ondelete="CASCADE", onupdate="NO ACTION"), nullable=False)
		      editor_id: Mapped[int | None] = mapped_column("editor_id", BigInteger(), ForeignKey("users.id", name="posts_editor_id_fkey", ondelete="SET NULL", onupdate="NO ACTION"), nullable=True)
		      title: Mapped[str] = mapped_column("title", Text(), nullable=False)
		      slug: Mapped[str] = mapped_column("slug", String(120), nullable=False)
		      body: Mapped[str | None] = mapped_column("body", Text(), nullable=True)
		      keywords: Mapped[list[str] | None] = mapped_column("keywords", ARRAY(Text()), nullable=True)
		      published: Mapped[bool] = mapped_column("published", Boolean(), server_default=text("false"), nullable=False)
		      rating: Mapped[Decimal | None] = mapped_column("rating", Numeric(3, 1), nullable=True)
		      metadata_: Mapped[dict] = mapped_column("metadata", JSONB(), server_default=text("JSONB '{}'"), nullable=False)
		      created_at: Mapped[datetime] = mapped_column("created_at", TIMESTAMP(timezone=True), server_default=text("CURRENT_TIMESTAMP"), nullable=False)
		      users_author_id: Mapped[Users] = relationship("Users", back_populates="posts_author_id_items", foreign_keys="[Posts.author_id]", uselist=False)
		      users_editor_id: Mapped[Users | None] = relationship("Users", back_populates="posts_editor_id_items", foreign_keys="[Posts.editor_id]", uselist=False)
		      comments_post_id_items: Mapped[list[Comments]] = relationship("Comments", back_populates="posts_post_id", foreign_keys="[Comments.post_id]")
		      post_tags_post_id_items: Mapped[list[PostTags]] = relationship("PostTags", back_populates="posts_post_id", foreign_keys="[PostTags.post_id]")

		  class Comments(Base):
		      __tablename__ = "comments"
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      post_id: Mapped[UUID] = mapped_column("post_id", PGUUID(as_uuid=True), ForeignKey("posts.id", name="comments_post_id_fkey", ondelete="CASCADE", onupdate="CASCADE"), nullable=False)
		      parent_id: Mapped[int | None] = mapped_column("parent_id", BigInteger(), ForeignKey("comments.id", name="comments_parent_id_fkey", ondelete="SET NULL", onupdate="NO ACTION"), nullable=True)
		      body: Mapped[str] = mapped_column("body", Text(), nullable=False)
		      posts_post_id: Mapped[Posts] = relationship("Posts", back_populates="comments_post_id_items", foreign_keys="[Comments.post_id]", uselist=False)
		      comments_parent_id: Mapped[Comments | None] = relationship("Comments", back_populates="comments_parent_id_items", foreign_keys="[Comments.parent_id]", remote_side="[Comments.id]", uselist=False)
		      comments_parent_id_items: Mapped[list[Comments]] = relationship("Comments", back_populates="comments_parent_id", foreign_keys="[Comments.parent_id]")

		  class Tags(Base):
		      __tablename__ = "tags"
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      name: Mapped[str] = mapped_column("name", String(64), unique=True, nullable=False)
		      post_tags_tag_id_items: Mapped[list[PostTags]] = relationship("PostTags", back_populates="tags_tag_id", foreign_keys="[PostTags.tag_id]")

		  class PostTags(Base):
		      __tablename__ = "post_tags"
		      __table_args__ = (
		          UniqueConstraint("post_id", "tag_id", name="post_tags_pair_key"),
		      )
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      post_id: Mapped[UUID] = mapped_column("post_id", PGUUID(as_uuid=True), ForeignKey("posts.id", name="post_tags_post_id_fkey", ondelete="CASCADE", onupdate="NO ACTION"), nullable=False)
		      tag_id: Mapped[int] = mapped_column("tag_id", BigInteger(), ForeignKey("tags.id", name="post_tags_tag_id_fkey", ondelete="RESTRICT", onupdate="NO ACTION"), nullable=False)
		      added_at: Mapped[datetime] = mapped_column("added_at", TIMESTAMP(timezone=True), server_default=text("CURRENT_TIMESTAMP"), nullable=False)
		      posts_post_id: Mapped[Posts] = relationship("Posts", back_populates="post_tags_post_id_items", foreign_keys="[PostTags.post_id]", uselist=False)
		      tags_tag_id: Mapped[Tags] = relationship("Tags", back_populates="post_tags_tag_id_items", foreign_keys="[PostTags.tag_id]", uselist=False)
		  "
		`);
		expect(generatedCode(vectorDesign)).toMatchInlineSnapshot(`
		  "from __future__ import annotations

		  import enum
		  from datetime import date, datetime, time, timedelta
		  from decimal import Decimal
		  from uuid import UUID

		  from sqlalchemy import (
		      ARRAY, BigInteger, Boolean, CHAR, Date, DOUBLE_PRECISION, ForeignKey, Identity, Index, Integer,
		      Interval, LargeBinary, Numeric, REAL, SmallInteger, String, Text, Time, TIMESTAMP, UniqueConstraint,
		      text,
		  )
		  from sqlalchemy.dialects.postgresql import CIDR, ENUM, INET, JSONB, MACADDR, MONEY, UUID as PGUUID, JSON
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

		  from pgvector.sqlalchemy import BIT as VectorBit, HALFVEC, SPARSEVEC, Vector

		  # Install PostgreSQL's vector extension through a migration: CREATE EXTENSION IF NOT EXISTS vector;

		  class Base(DeclarativeBase):
		      pass

		  class Documents(Base):
		      __tablename__ = "documents"
		      __table_args__ = (
		          Index("documents_embedding_idx", text("\\"embedding\\" vector_cosine_ops"), unique=False, postgresql_using="hnsw", postgresql_with={"m": 16, "ef_construction": 64}),
		          Index("documents_summary_ivfflat", text("\\"summary_embedding\\" halfvec_l2_ops"), unique=False, postgresql_using="ivfflat", postgresql_with={"lists": 100}),
		          Index("documents_keywords_embedding_idx", text("\\"keywords_embedding\\" sparsevec_ip_ops"), unique=False, postgresql_using="hnsw"),
		          Index("documents_signature_idx", text("\\"signature\\" bit_hamming_ops"), unique=False, postgresql_using="hnsw"),
		      )
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      content: Mapped[str] = mapped_column("content", Text(), nullable=False)
		      embedding: Mapped[list[float]] = mapped_column("embedding", Vector(1536), nullable=False)
		      summary_embedding: Mapped[list[float] | None] = mapped_column("summary_embedding", HALFVEC(768), nullable=True)
		      keywords_embedding: Mapped[object | None] = mapped_column("keywords_embedding", SPARSEVEC(30000), nullable=True)
		      signature: Mapped[str | None] = mapped_column("signature", VectorBit(256), nullable=True)
		  "
		`);
		expect(generatedCode(typeCatalogDesign)).toMatchInlineSnapshot(`
		  "from __future__ import annotations

		  import enum
		  from datetime import date, datetime, time, timedelta
		  from decimal import Decimal
		  from uuid import UUID

		  from sqlalchemy import (
		      ARRAY, BigInteger, Boolean, CHAR, Date, DOUBLE_PRECISION, ForeignKey, Identity, Index, Integer,
		      Interval, LargeBinary, Numeric, REAL, SmallInteger, String, Text, Time, TIMESTAMP, UniqueConstraint,
		      text,
		  )
		  from sqlalchemy.dialects.postgresql import CIDR, ENUM, INET, JSONB, MACADDR, MONEY, UUID as PGUUID, JSON
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

		  from pgvector.sqlalchemy import BIT as VectorBit, HALFVEC, SPARSEVEC, Vector

		  # Install PostgreSQL's vector extension through a migration: CREATE EXTENSION IF NOT EXISTS vector;

		  class Base(DeclarativeBase):
		      pass

		  class Mood(enum.Enum):
		      HAPPY = "happy"
		      SAD = "sad"
		      IN_BETWEEN = "in-between"

		  MoodType = ENUM(Mood, name="mood", create_type=True, values_callable=lambda members: [member.value for member in members])

		  class TypeCatalog(Base):
		      __tablename__ = "type_catalog"
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      integer_value: Mapped[int | None] = mapped_column("integer_value", Integer(), nullable=True)
		      smallint_value: Mapped[int | None] = mapped_column("smallint_value", SmallInteger(), nullable=True)
		      text_value: Mapped[str | None] = mapped_column("text_value", Text(), nullable=True)
		      varchar_value: Mapped[str | None] = mapped_column("varchar_value", String(40), nullable=True)
		      varchar_unbounded: Mapped[str | None] = mapped_column("varchar_unbounded", String(), nullable=True)
		      char_value: Mapped[str | None] = mapped_column("char_value", CHAR(2), nullable=True)
		      uuid_value: Mapped[UUID | None] = mapped_column("uuid_value", PGUUID(as_uuid=True), nullable=True)
		      boolean_value: Mapped[bool | None] = mapped_column("boolean_value", Boolean(), nullable=True)
		      numeric_value: Mapped[Decimal | None] = mapped_column("numeric_value", Numeric(None), nullable=True)
		      money_amount: Mapped[Decimal | None] = mapped_column("money_amount", Numeric(12, 2), nullable=True)
		      real_value: Mapped[float | None] = mapped_column("real_value", REAL(), nullable=True)
		      double_value: Mapped[float | None] = mapped_column("double_value", DOUBLE_PRECISION(), nullable=True)
		      date_value: Mapped[date | None] = mapped_column("date_value", Date(), nullable=True)
		      time_value: Mapped[time | None] = mapped_column("time_value", Time(timezone=False), nullable=True)
		      timetz_value: Mapped[time | None] = mapped_column("timetz_value", Time(timezone=True), nullable=True)
		      timestamp_value: Mapped[datetime | None] = mapped_column("timestamp_value", TIMESTAMP(timezone=False), nullable=True)
		      timestamptz_value: Mapped[datetime | None] = mapped_column("timestamptz_value", TIMESTAMP(timezone=True), nullable=True)
		      interval_value: Mapped[timedelta | None] = mapped_column("interval_value", Interval(), nullable=True)
		      json_value: Mapped[dict | None] = mapped_column("json_value", JSON(), nullable=True)
		      jsonb_value: Mapped[dict | None] = mapped_column("jsonb_value", JSONB(), nullable=True)
		      bytea_value: Mapped[bytes | None] = mapped_column("bytea_value", LargeBinary(), nullable=True)
		      inet_value: Mapped[str | None] = mapped_column("inet_value", INET(), nullable=True)
		      cidr_value: Mapped[str | None] = mapped_column("cidr_value", CIDR(), nullable=True)
		      macaddr_value: Mapped[str | None] = mapped_column("macaddr_value", MACADDR(), nullable=True)
		      money_value: Mapped[Decimal | None] = mapped_column("money_value", MONEY(), nullable=True)
		      bit_value: Mapped[str | None] = mapped_column("bit_value", VectorBit(8), nullable=True)
		      vector_value: Mapped[list[float] | None] = mapped_column("vector_value", Vector(3), nullable=True)
		      halfvec_value: Mapped[list[float] | None] = mapped_column("halfvec_value", HALFVEC(3), nullable=True)
		      sparsevec_value: Mapped[object | None] = mapped_column("sparsevec_value", SPARSEVEC(3), nullable=True)
		      mood_value: Mapped[Mood | None] = mapped_column("mood_value", MoodType, nullable=True)
		      mood_history: Mapped[list[Mood] | None] = mapped_column("mood_history", ARRAY(MoodType), nullable=True)
		      integer_list: Mapped[list[int] | None] = mapped_column("integer_list", ARRAY(Integer()), nullable=True)
		      uuid_list: Mapped[list[UUID] | None] = mapped_column("uuid_list", ARRAY(PGUUID(as_uuid=True)), nullable=True)
		      integer_default: Mapped[int] = mapped_column("integer_default", Integer(), server_default=text("42"), nullable=False)
		      numeric_default: Mapped[Decimal] = mapped_column("numeric_default", Numeric(None), server_default=text("1.50"), nullable=False)
		      text_default: Mapped[str] = mapped_column("text_default", Text(), server_default=text("'it''s \\"quoted\\"'"), nullable=False)
		      date_default: Mapped[date] = mapped_column("date_default", Date(), server_default=text("DATE '2024-01-31'"), nullable=False)
		  "
		`);
		expect(generatedCode(awkwardNamesDesign)).toMatchInlineSnapshot(`
		  "from __future__ import annotations

		  import enum
		  from datetime import date, datetime, time, timedelta
		  from decimal import Decimal
		  from uuid import UUID

		  from sqlalchemy import (
		      ARRAY, BigInteger, Boolean, CHAR, Date, DOUBLE_PRECISION, ForeignKey, Identity, Index, Integer,
		      Interval, LargeBinary, Numeric, REAL, SmallInteger, String, Text, Time, TIMESTAMP, UniqueConstraint,
		      text,
		  )
		  from sqlalchemy.dialects.postgresql import CIDR, ENUM, INET, JSONB, MACADDR, MONEY, UUID as PGUUID, JSON
		  from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


		  class Base(DeclarativeBase):
		      pass

		  class OrderStatus(enum.Enum):
		      NEW = "new"
		      IN_PROGRESS = "in progress"
		      _2ND_TRY = "2nd try"
		      NONE = "None"

		  OrderStatusType = ENUM(OrderStatus, name="order-status", create_type=True, values_callable=lambda members: [member.value for member in members])

		  class Class(Base):
		      __tablename__ = "class"
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      from_: Mapped[str] = mapped_column("from", Text(), nullable=False)
		      import_: Mapped[str | None] = mapped_column("import", Text(), nullable=True)
		      type: Mapped[str | None] = mapped_column("type", Text(), nullable=True)
		      _2fa_secret: Mapped[str | None] = mapped_column("2fa_secret", Text(), nullable=True)
		      display_name: Mapped[str | None] = mapped_column("Display Name", Text(), nullable=True)
		      user_id: Mapped[int | None] = mapped_column("user_id", Integer(), nullable=True)
		      user_id_2: Mapped[int | None] = mapped_column("userId", Integer(), nullable=True)
		      order_items_class_id_items: Mapped[list[OrderItems]] = relationship("OrderItems", back_populates="class_class_id", foreign_keys="[OrderItems.class_id]")

		  class OrderItems(Base):
		      __tablename__ = "order_items"
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		      class_id: Mapped[int] = mapped_column("class_id", BigInteger(), ForeignKey("class.id", name="order_items_class_id_fkey", ondelete="NO ACTION", onupdate="NO ACTION"), nullable=False)
		      status: Mapped[OrderStatus] = mapped_column("status", OrderStatusType, nullable=False)
		      class_class_id: Mapped[Class] = relationship("Class", back_populates="order_items_class_id_items", foreign_keys="[OrderItems.class_id]", uselist=False)

		  class OrderItems_2(Base):
		      __tablename__ = "OrderItems"
		      id: Mapped[int] = mapped_column("id", BigInteger(), Identity(always=True), primary_key=True)
		  "
		`);
	});

	test("maps relationship shapes and generated constraint names", () => {
		const result = generateSqlAlchemyModels(blogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.code).toContain("ForeignKey(\"users.id\", name=\"posts_author_id_fkey\"");
		expect(result.code).toContain("remote_side=\"[Comments.id]\"");
		expect(result.code).toContain("uselist=False");
		expect(result.code).toContain("UniqueConstraint(\"post_id\", \"tag_id\"");
		expect(result.code).toContain("Mapped[list[Posts]] = relationship(\"Posts\"");
		expect(result.code).toContain("foreign_keys=\"[Posts.author_id]\"");
		expect(result.code).toContain("foreign_keys=\"[Posts.editor_id]\"");
		expect(result.code).toContain("class PostTags(Base):");
		expect(result.code).toContain("back_populates=");
	});

	test("maps the full PostgreSQL type catalog and defaults", () => {
		const result = generateSqlAlchemyModels(typeCatalogDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const fragment of ["ARRAY(Integer())", "ARRAY(PGUUID(as_uuid=True))", "Numeric(12, 2)", "TIMESTAMP(timezone=True)", "JSONB()", "ENUM(Mood", "server_default=text(\"DATE '"]) {
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
		for (const fragment of ["postgresql_using=\"gin\"", "DESC NULLS LAST", "jsonb_path_ops", "postgresql_include=[\"title\"]", "postgresql_nulls_not_distinct=True", "pages_per_range", "fastupdate"]) {
			expect(result.code).toContain(fragment);
		}
	});

	test("maps pgvector types and vector indexes", () => {
		const result = generateSqlAlchemyModels(vectorDesign);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		for (const fragment of ["Vector(1536)", "HALFVEC(768)", "SPARSEVEC(30000)", "VectorBit(256)", "postgresql_using=\"hnsw\"", "vector_cosine_ops", "halfvec_l2_ops"]) {
			expect(result.code).toContain(fragment);
		}
		expect(result.code).toContain("CREATE EXTENSION IF NOT EXISTS vector");
	});

	test("generates stable single-table output", () => {
		expect(generateSqlAlchemyModels(minimalDesign)).toEqual(generateSqlAlchemyModels(minimalDesign));
	});
});
