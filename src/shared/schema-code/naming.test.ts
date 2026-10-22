import { describe, expect, test } from "bun:test";
import { awkwardNamesDesign, blogDesign } from "./fixtures";
import {
	modelWords,
	planRelationshipNames,
	pluralize,
	singularize,
	splitWords,
} from "./naming";

describe("schema code naming", () => {
	test("splits identifiers in any case style into words", () => {
		expect(splitWords("post_tags")).toEqual(["post", "tags"]);
		expect(splitWords("OrderItems")).toEqual(["order", "items"]);
		expect(splitWords("userId")).toEqual(["user", "id"]);
		expect(splitWords("Display Name")).toEqual(["display", "name"]);
		expect(splitWords("order-status")).toEqual(["order", "status"]);
		expect(splitWords("HTTPRequest")).toEqual(["http", "request"]);
		expect(splitWords("2fa_secret")).toEqual(["2fa", "secret"]);
	});

	test("singularizes and pluralizes regular, irregular, and uncountable words", () => {
		expect(singularize("users")).toBe("user");
		expect(singularize("categories")).toBe("category");
		expect(singularize("addresses")).toBe("address");
		expect(singularize("boxes")).toBe("box");
		expect(singularize("status")).toBe("status");
		expect(singularize("statuses")).toBe("status");
		expect(singularize("buses")).toBe("bus");
		expect(pluralize("statuses")).toBe("statuses");
		expect(singularize("people")).toBe("person");
		expect(singularize("data")).toBe("data");
		expect(pluralize("user")).toBe("users");
		expect(pluralize("posts")).toBe("posts");
		expect(pluralize("category")).toBe("categories");
		expect(pluralize("key")).toBe("keys");
		expect(pluralize("status")).toBe("statuses");
		expect(pluralize("person")).toBe("people");
		expect(pluralize("metadata")).toBe("metadata");
	});

	test("names models in the singular", () => {
		expect(blogDesign.tables.map((table) => modelWords(table).join("_"))).toEqual([
			"user",
			"profile",
			"post",
			"comment",
			"tag",
			"post_tag",
		]);
	});

	test("names both sides of every relationship shape in the blog", () => {
		const plan = planRelationshipNames(blogDesign);
		const names = Object.fromEntries(
			[...plan.relationships].map(([id, names]) => [
				id,
				[names.forward.join("_"), names.backward.join("_"), names.backwardIsList],
			]),
		);
		expect(names).toEqual({
			r_posts_author: ["author", "author_posts", true],
			r_posts_editor: ["editor", "editor_posts", true],
			r_profiles_user: ["user", "profile", false],
			r_comments_post: ["post", "comments", true],
			r_comments_parent: ["parent", "children", true],
			r_post_tags_post: ["post", "post_tags", true],
			r_post_tags_tag: ["tag", "post_tags", true],
		});
		expect(plan.manyToMany.get("m_posts_tags")).toEqual({
			left: ["tags"],
			right: ["posts"],
		});
	});

	test("keeps relationship names clear of column names", () => {
		const plan = planRelationshipNames(awkwardNamesDesign);
		expect(plan.relationships.get("r_order_items_class")).toEqual({
			forward: ["class"],
			backward: ["order", "items"],
			backwardIsList: true,
		});

		const clashing = {
			...blogDesign,
			tables: blogDesign.tables.map((table) =>
				table.id === "t_posts"
					? {
							...table,
							columns: [
								...table.columns,
								{ ...table.columns[1], id: "c_posts_author_name", name: "author" },
							],
						}
					: table,
			),
		};
		const clash = planRelationshipNames(clashing).relationships.get("r_posts_author");
		expect(clash?.forward).toEqual(["author", "ref"]);
	});
});
