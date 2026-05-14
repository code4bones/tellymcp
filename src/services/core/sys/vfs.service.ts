// import { useDB, GQLSchema, AuthMixin } from "c4b-lib";
import vfsSchema from "@src/services/core/sys/mixins/vfs/vfs.schema";
import vfsXXX, { VFSEvents } from "@src/services/core/sys/mixins/events/vfsXXX";
import _ from "lodash";
import { GQLSchema } from "@src/lib/moleculer";
import { DBMixin } from "@src/lib/mixins/db";
import { Errors as MoleculerErrors } from "moleculer";
import { randomUUID } from "crypto";
import { getVfsUiConfig, resolveVfsCapabilities } from "@src/lib/vfsCapabilities";
import { isInternalCall } from "../api/mixins/session";
import config from "./mixins/s3/minio.config";
import { formatMinioStorageRef, parseStorageRef } from "./mixins/s3/storage-ref";
import { isDetachedWorkerProcess, subscribeVfsBridgeEvents } from "@src/lib/vfsEventBridge";

const parseCsv = (value?: string) =>
	(value || "")
		.split(",")
		.map(item => item.trim())
		.filter(Boolean);

const VFS_ADMIN_ACCESS = {
	roles: parseCsv(process.env.VFS_ADMIN_ROLES || process.env.MINIO_ADMIN_ROLES),
	groups: parseCsv(process.env.VFS_ADMIN_GROUPS || process.env.MINIO_ADMIN_GROUPS),
};

const vfsService: GQLSchema = {
	name: "vfs",
	mixins: [DBMixin, vfsXXX, vfsSchema],
	async started() {
		const { default_scope } = getVfsUiConfig();
		await this.ensureRoot(default_scope);
		if (!isDetachedWorkerProcess()) {
			this.vfsBridgeUnsubscribe = await subscribeVfsBridgeEvents(async payload => {
				if (payload?.changed) {
					await this.broker.broadcast("graphql.publish", {
						tag: VFSEvents.vfsChanged,
						payload: payload.changed,
					});
					const bridgeEvent = String(payload.changed?.event || "");
					if (bridgeEvent === "tiles-create" || bridgeEvent === "tiles-delete") {
						await this.broker.broadcast("graphql.publish", {
							tag: VFSEvents.vfsTilesChanged,
							payload: {
								event: bridgeEvent,
								node_ids:
									payload.changed?.node_id != null
										? [Number(payload.changed.node_id)]
										: [],
								parent_id: payload.changed?.parent_id ?? null,
								old_parent_id: payload.changed?.old_parent_id ?? null,
							},
						});
					}
				}
				if (payload?.nodeChanged) {
					await this.broker.broadcast("graphql.publish", {
						tag: VFSEvents.vfsNodeChanged,
						payload: payload.nodeChanged,
					});
				}
			});
		}
	},
	async stopped() {
		await this.vfsBridgeUnsubscribe?.().catch?.(() => null);
		this.vfsBridgeUnsubscribe = null;
	},
	hooks: {
		before: {
			"vfs*|vs*": ["withObjectAccess"],
		},
	},
	dependencies: [],
	actions: {
		emitVfsEvents: {
			visibility: "protected",
			params: {
				changed: { type: "object", optional: true },
				nodeChanged: { type: "object", optional: true },
			},
			handler(ctx) {
				if (ctx.params.changed) {
					this.vfsChanged(ctx, null, ctx.params.changed);
				}
				if (ctx.params.nodeChanged) {
					this.vfsNodeChanged(ctx, null, ctx.params.nodeChanged);
				}
				return { ok: true };
			},
		},
		vfsNodeExists: {
			graphql: {
				query: "vfsNodeExists(node:VFSNodeExistsInput,throw:Boolean):JSON",
			},
			handler(ctx) {
				const {
					node: { parent_id, name, type, scope },
					throw: th,
				} = ctx.params;
				return this.db("storage.nodes")
					.where(function () {
						if (parent_id) this.where({ parent_id });
						this.andWhere({ name, type, scope });
					})
					.then(res => {
						if (res.length) {
							if (th) throw new Error("Имя уже используется !");
							else {
								return { error: true, message: "Имя уже используется" };
							}
						}
						return {
							error: false,
							message: "Имя доступно",
						};
					});
			},
		},
		vfsScopes: {
			graphql: {
				query: "vfsScopes(scope:String):JSON",
			},
			object_access: true,
			handler(ctx) {
				const { scope } = ctx.params;
				return this.db("storage.v_scopes")
					.where(function () {
						if (scope) this.where({ scope });
					})
					.then(res => res?.map(({ scope: s }) => s));
			},
		},

		vfsCreateDir: {
			graphql: {
				mutation: "vfsCreateDir(node:VFSCreateNode!,scope:String):VFSNode",
			},
			object_access: true,
			async handler(ctx) {
				const { node, scope = "fs" } = ctx.params;
				const parentNode = node.parent_id
					? await this.getNode(node.parent_id)
					: await this.getRoot(ctx, scope);
				await this.assertNodePermission(ctx, parentNode, "write");
				if (!node.parent_id && node.name === "/") {
					return this.hydrateNodeVisibility(parentNode);
				}
				const parts = this.pathParts(node.name); // node.name.split("/").filter((p) => p?.length > 0) as string[];
				const createOne = async parent_id => {
					const name = parts.shift();
					const dir = await this.createNode(
						{
							...ctx.params.node,
							name,
							parent_id,
							type: "DIR",
							scope,
							visibility: "inherit",
						},
						ctx
					);
					if (parts.length) return createOne(dir.node_id);
					return this.hydrateNodeVisibility(dir);
				};
				return createOne(node.parent_id).then(dir => {
					this.vfsChanged(ctx, null, {
						event: "create_dir",
						dir,
					});
					this.vfsNodeChanged(ctx, null, {
						old_parent_id: node.parent_id,
						...dir,
					});
					return dir;
				});
			},
		},
		vsCreateFile: {
			graphql: {
				mutation: "vfsCreateFile(file:VFSCreateFile!):VFSNode",
			},
			object_access: true,
			async handler(ctx) {
				const {
					file: { parent_id, hash, name },
				} = ctx.params;
				const storageRef = parseStorageRef(hash);
				const parentNode = await this.getNode(parent_id);
				await this.assertNodePermission(ctx, parentNode, "write");
				const exists = await this.db("storage.nodes")
					.where({ parent_id, name, type: "FILE" })
					.first();

				if (exists) {
					throw new Error("Файл с таким именем уже существует!");
				}
				if (storageRef?.kind !== "minio") {
					throw new Error("VFS files must reference MinIO objects");
				}

				const objectExists = await ctx.call("minio.objectExistsByRef", { ref: hash });
				if (!objectExists) {
					throw new Error("MinIO object not found");
				}

				return this.db("storage.nodes")
					.insert({
						type: "FILE",
						parent_id,
						public_url: randomUUID(),
						hash,
						name,
						sub: ctx.meta.user?.sub || null,
						scope: parentNode.scope,
						visibility: "inherit",
					})
					.onConflict(["parent_id", "name"])
					.merge({
						type: "FILE",
						parent_id,
						hash,
						name,
						sub: ctx.meta.user?.sub || null,
						scope: parentNode.scope,
						visibility: "inherit",
					})
					.returning("*")
					.then(([f]) => f)
					.then(file => this.hydrateNodeVisibility(file))
					.then(file => {
						this.vfsChanged(ctx, null, {
							event: "create_file",
							file,
						});
						this.vfsNodeChanged(ctx, null, {
							old_parent_id: parent_id,
							...file,
						});
						return file;
					});
			},
		},
		vfsCreatePreview: {
			graphql: {
				mutation: "vfsCreatePreview(node_id:Int!,size:Int,force:Boolean):JSON",
			},
			object_access: true,
			async handler(ctx) {
				const nodeId = Number(ctx.params.node_id);
				const node = await this.getNode(nodeId);
				await this.assertNodePermission(ctx, node, "write");
				return ctx.call("minio.createPreviewByNodeId", {
					nodeId,
					size: ctx.params.size,
					force: Boolean(ctx.params.force),
				});
			},
		},
		vsList: {
			graphql: {
				query: "vfsList(list:VFSListInput):[VFSNode!]",
			},
			object_access: true,
			async handler(ctx) {
				const rows = await this.db("storage.nodes").where(function () {
					const { list } = ctx.params;
					if (!list) return this;
					const { parent_id, type } = list;
					if (parent_id) this.where({ parent_id });
					else this.whereNull("parent_id");
					if (type) this.where({ type });
				});
				const visibleRows = await this.filterNodesByPermission(ctx, rows, "list");
				return this.hydrateNodesVisibility(visibleRows);
			},
		},
		vsNode: {
			graphql: {
				query: "vfsNode(parent_id:Int,type:VFSNodeType,scope:String,sort:[VFSSort!]):[VFSNode!]",
			},
			object_access: true,
			handler(ctx) {
				const {
					parent_id,
					type,
					scope = "fs",
					sort = [{ column: "name", order: "asc" }],
				} = ctx.params;
				this.vfsDebug(ctx, "vsNode", {
					parent_id: parent_id ?? null,
					type: type ?? null,
					scope,
					sort,
				});
				return this.db("storage.nodes")
					.where(function () {
						this.where({ scope });
						if (type) this.where({ type });
						if (parent_id) this.where({ parent_id });
						else this.whereNull("parent_id");
					})
					.orderBy([
						{ column: "type", order: "asc" },
						...sort,
						// { column: "name", order: "asc" },
					])
					.then(rows => this.filterNodesByPermission(ctx, rows, "list"))
					.then(rows => this.hydrateNodesVisibility(rows));
			},
		},
		vsDirTree: {
			graphql: {
				query: "vfsDirTree(scope:String):JSON",
			},
			object_access: true,
			handler(ctx) {
				const { scope = "fs" } = ctx.params;
				return this.db
					.raw(`select * from storage."vfsBuildTree"(NULL,?)`, [scope])
					.then(({ rows }) => {
						const [res] = rows;
						return res?.vfsBuildTree;
					});
			},
		},
		vsGetTree: {
			graphql: {
				query: "vfsGetTree(scope:String):JSON",
			},
			object_access: true,
			handler(ctx) {
				const getNodes = (parent_id?: number) => {
					const { scope = "fs" } = ctx.params;
					return this.db("storage.nodes")
						.where(function () {
							// this.where({ type: "DIR" });
							this.where({ scope });
							if (parent_id) this.where({ parent_id });
							else this.whereNull("parent_id");
						})
						.orderBy("name", "asc");
				};

				const iterate = async (parent: any) => {
					parent.childrens = await getNodes(parent.node_id);
					if (!parent.childrens?.length) {
						delete parent.childrens;
					} else {
						await Promise.all(parent.childrens.map(node => iterate(node)));
					}
					return parent;
				};
				return iterate({});
			},
		},
		vfsLookup: {
			graphql: {
				query: "vfsLookup(lookup:VFSLookupInput):[VFSLookupResult!]",
			},
			object_access: true,
			async handler(ctx) {
				const { lookup } = ctx.params;
				const rows = await this.db("storage.nodes")
					.where(function () {
						if (lookup?.type) this.where({ type: lookup.type });
					})
					.orderBy("name", "asc");

				const result = await Promise.all(
					(await this.hydrateNodesVisibility(rows)).map(async node => ({
						name: node.name,
						node_id: node.node_id,
						public_url: node.public_url,
						parent_id: node.parent_id,
						ctime: node.ctime,
						mtime: node.mtime,
						atime: node.atime,
						hash: node.hash,
						type: node.type,
						path: await this.getNodePathString(node.node_id),
						visibility: node.visibility,
						effectiveVisibility: node.effectiveVisibility,
						acl_count: node.acl_count || 0,
						has_acl: Boolean(node.has_acl),
						has_tiles: Boolean(node.has_tiles),
					}))
				);

				const visibleResult = await this.filterNodePayloadsByPermission(ctx, result, "read");

				if (!lookup?.mask) {
					return visibleResult;
				}

				const mask = new RegExp(lookup.mask, "i");
				return visibleResult.filter(
					node => mask.test(node.path || "") || mask.test(node.name || "")
				);
			},
		},
		vfsListFiles: {
			graphql: {
				query: "vfsListFiles(list:VFSListFilesInput):[VFSFileResult!]",
			},
			object_access: true,
			async handler(ctx) {
				const { list } = ctx.params;
				this.vfsDebug(ctx, "vfsListFiles", {
					list: list || null,
				});
				const rows = await this.db("storage.nodes")
					.where(function () {
						this.where({ type: "FILE" });
						if (!list) return;
						if (list.scope) this.where({ scope: list.scope });
						if (list.node_id) this.where({ node_id: list.node_id });
						if (list.parent_id) this.where({ parent_id: list.parent_id });
					})
					.orderBy("name", "asc");

				const visibleRows = await this.filterNodesByPermission(ctx, rows, "read");
				const hydratedRows = await this.hydrateNodesVisibility(visibleRows);
				const files = await Promise.all(
					hydratedRows.map(node => this.resolveVfsFileResult(ctx, node))
				);

				if (!list?.mask) {
					return files;
				}

				const mask = new RegExp(list.mask, "i");
				return files.filter(file => mask.test(file.path || "") || mask.test(file.file_name || ""));
			},
		},
		vfsDirectoryEntries: {
			graphql: {
				query:
					"vfsDirectoryEntries(parent_id:Int,scope:String,first:Int,max:Int,search:String,sortField:VFSDirectorySortField,sortOrder:VFSSortOrder):VFSDirectoryEntryPage!",
			},
			object_access: true,
			async handler(ctx) {
				const {
					parent_id = null,
					scope = "fs",
					first,
					max,
					search,
					sortField,
					sortOrder,
				} = ctx.params;
					const { first: normalizedFirst, max: normalizedMax } = this.normalizeAclPage(first, max);
				const normalizedSearch = String(search || "").trim();
				const normalizedSortField = this.normalizeDirectorySortField(sortField);
				const normalizedSortOrder = sortOrder === "desc" ? "desc" : "asc";
				this.vfsDebug(ctx, "vfsDirectoryEntries", {
					parent_id,
					scope,
					first: normalizedFirst,
					max: normalizedMax,
					search: normalizedSearch || null,
					sortField: normalizedSortField,
					sortOrder: normalizedSortOrder,
				});

				const rows = await this.db("storage.nodes")
					.where(function () {
						this.where({ scope });
						if (parent_id) this.where({ parent_id });
						else this.whereNull("parent_id");
						if (normalizedSearch) {
							this.andWhereILike("name", `%${normalizedSearch}%`);
						}
					})
					.orderBy([
						{ column: "type", order: "asc" },
						...(normalizedSortField === "name"
							? [{ column: "name", order: normalizedSortOrder }]
							: [{ column: "name", order: "asc" }]),
					]);

				const visibleRows = await this.filterNodesByPermission(ctx, rows, "list");
				const hydratedRows = await this.hydrateNodesVisibility(visibleRows);

				if (normalizedSortField === "size") {
					const resolvedEntries = await Promise.all(
						hydratedRows.map(node => this.resolveVfsDirectoryEntryResult(ctx, node))
					);
					const sortedEntries = this.sortVfsDirectoryEntries(
						resolvedEntries,
						normalizedSortField,
						normalizedSortOrder
					);
					const pageItems = sortedEntries.slice(
						normalizedFirst,
						normalizedFirst + normalizedMax
					);
					return {
						first: normalizedFirst,
						max: normalizedMax,
						total: sortedEntries.length,
						hasMore: normalizedFirst + pageItems.length < sortedEntries.length,
						items: pageItems,
					};
				}

				const pageRows = hydratedRows.slice(normalizedFirst, normalizedFirst + normalizedMax);
				const pageItems = await Promise.all(
					pageRows.map(node => this.resolveVfsDirectoryEntryResult(ctx, node))
				);
				return {
					first: normalizedFirst,
					max: normalizedMax,
					total: visibleRows.length,
					hasMore: normalizedFirst + pageItems.length < visibleRows.length,
					items: pageItems,
				};
			},
		},
		vfsDirectoryEntry: {
			graphql: {
				query: "vfsDirectoryEntry(node_id:Int!):VFSDirectoryEntry",
			},
			object_access: true,
			async handler(ctx) {
				const nodeId = Number(ctx.params.node_id);
				if (!Number.isInteger(nodeId) || nodeId <= 0) {
					return null;
				}
				const node = await this.getNode(nodeId);
				if (!node) {
					return null;
				}
				await this.assertNodePermission(ctx, node, "read");
				const hydratedNode = await this.hydrateNodeVisibility(node);
				return this.resolveVfsDirectoryEntryResult(ctx, hydratedNode);
			},
		},
		vfsSearchTree: {
			graphql: {
				query: "vfsSearchTree(scope:String,search:String!,first:Int,max:Int):JSON",
			},
			object_access: true,
			async handler(ctx) {
				const { scope, search, first, max } = ctx.params;
				const normalizedSearch = String(search || "").trim();
				const { first: normalizedFirst, max: normalizedMax } = this.normalizeSearchTreePage(first, max);

				if (!normalizedSearch) {
						return {
							search: "",
							scope: scope || null,
							first: normalizedFirst,
							max: normalizedMax,
							totalMatches: 0,
						limitedMatches: 0,
						totalNodes: 0,
						hasMore: false,
						topLevelIds: [],
						items: [],
					};
				}

				this.vfsDebug(ctx, "vfsSearchTree", {
					scope: scope || null,
					search: normalizedSearch,
					first: normalizedFirst,
					max: normalizedMax,
				});

				const rows = await this.db("storage.nodes")
					.where(function () {
						if (scope) {
							this.where({ scope });
						}
						this.andWhereILike("name", `%${normalizedSearch}%`);
					})
					.orderBy([
						{ column: "type", order: "asc" },
						{ column: "name", order: "asc" },
					]);

				const visibleMatches = await this.filterNodesByAclIndexPermission(ctx, rows);
				const pagedMatches = visibleMatches.slice(
					normalizedFirst,
					normalizedFirst + normalizedMax
				);
				const matchIds = new Set(pagedMatches.map(node => node.node_id));

				const ancestorGroups = await Promise.all(
					pagedMatches.map(node => this.getNodeAncestors(node.node_id))
				);
				const closureMap = new Map<number, Record<string, any>>();
				ancestorGroups.flat().forEach(node => {
					if (node?.node_id) {
						closureMap.set(node.node_id, node);
					}
				});
				pagedMatches.forEach(node => {
					if (node?.node_id) {
						closureMap.set(node.node_id, node);
					}
				});

				const visibleClosureRows = await this.filterNodesByAclIndexPermission(
					ctx,
					Array.from(closureMap.values())
				);
				const hydratedRows = (await this.hydrateNodesVisibility(visibleClosureRows)) as Array<
					Record<string, any>
				>;
				const nodeById = new Map<number, Record<string, any>>(
					hydratedRows.map(node => [Number(node.node_id), node])
				);
				const pathEntries = await Promise.all(
					hydratedRows.map(async node => [
						node.node_id,
						await this.getNodePathString(node.node_id),
					] as const)
				);
				const pathById = new Map(pathEntries);
				const childrenByParent = new Map<number, Array<{ node_id: number; type: string }>>();
				const topLevelIds: number[] = [];

				for (const node of hydratedRows) {
					if (node.parent_id && nodeById.has(node.parent_id)) {
						const children = childrenByParent.get(node.parent_id) || [];
						children.push({
							node_id: node.node_id,
							type: node.type,
						});
						childrenByParent.set(node.parent_id, children);
					} else {
						topLevelIds.push(node.node_id);
					}
				}

				const compareNodeIds = (leftId: number, rightId: number) => {
					const left = nodeById.get(leftId);
					const right = nodeById.get(rightId);
					if (!left || !right) return 0;
					if (left.type !== right.type) {
						return left.type === "DIR" ? -1 : 1;
					}
					return new Intl.Collator("ru", {
						numeric: true,
						sensitivity: "base",
					}).compare(left.name || "", right.name || "");
				};

				topLevelIds.sort(compareNodeIds);
				childrenByParent.forEach(children => {
					children.sort((left, right) => compareNodeIds(left.node_id, right.node_id));
				});

				return {
					search: normalizedSearch,
					scope: scope || null,
					first: normalizedFirst,
					max: normalizedMax,
					totalMatches: visibleMatches.length,
					limitedMatches: pagedMatches.length,
					totalNodes: hydratedRows.length,
					hasMore: normalizedFirst + pagedMatches.length < visibleMatches.length,
					topLevelIds,
					items: hydratedRows.map(node => ({
						...node,
						path: pathById.get(node.node_id) || "/",
						search_match: matchIds.has(node.node_id),
						search_virtual: false,
						children: childrenByParent.get(node.node_id) || [],
					})),
				};
			},
		},
		vfsDeleteNode: {
			graphql: {
				mutation: "vfsDeleteNode(node_id:[Int!]!):[VFSNode!]",
			},
			object_access: true,
			async handler(ctx) {
				const rootIds = _.uniq((ctx.params.node_id || []).filter(Boolean));
				if (!rootIds.length) {
					return [];
				}

				const roots = await this.db("storage.nodes").whereIn("node_id", rootIds).select("*");
				await Promise.all(roots.map(node => this.assertNodePermission(ctx, node, "delete")));
				const descendantIds = (
					await Promise.all(rootIds.map(nodeId => this.getDescendantNodeIds(nodeId)))
				).flat();
				const deleteIds = _.uniq([...rootIds, ...descendantIds]);
				const nodesToDelete = await this.db("storage.nodes")
					.whereIn("node_id", deleteIds)
					.select("*");
				await this.assertNodesDeletionAllowed(nodesToDelete);
				const hydratedNodesToDelete = await this.hydrateNodesVisibility(nodesToDelete);
				const previewFileNodeIds = _.uniq(
					nodesToDelete
						.filter(node => node?.type === "FILE")
						.map(node => Number(node.node_id))
						.filter(Boolean)
				);

				if (previewFileNodeIds.length) {
					await ctx.call("minio.deletePreviewsByNodeIds", {
						nodeIds: previewFileNodeIds,
					});
				}

				await this.db("storage.nodes").whereIn("node_id", deleteIds).delete();

				const minioRefs = _.uniq(
					_.compact(nodesToDelete.map(({ hash }) => hash)).flatMap(hash => {
						const parsed = parseStorageRef(hash);
						if (parsed?.kind === "minio") {
							return [hash];
						}
						if (hash) {
							this.logger.warn(`Skipping non-MinIO VFS storage ref ${hash}`);
						}
						return [];
					})
				);

				if (minioRefs.length) {
					this.logger.info("Deleting descendant MinIO objects", minioRefs);
					await Promise.all(minioRefs.map(ref => ctx.call("minio.deleteByRef", { ref })));
				}

				this.vfsChanged(ctx, null, {
					event: "delete",
					deleted: hydratedNodesToDelete,
				});

				hydratedNodesToDelete
					.filter(node => rootIds.includes(node.node_id))
					.forEach(node => {
						this.vfsNodeChanged(ctx, null, {
							old_parent_id: node.parent_id,
							...node,
						});
					});

				return hydratedNodesToDelete;
			},
		},
		vfsRename: {
			graphql: {
				mutation: "vfsRename(node_id:Int!,name:String!):VFSNode",
			},
			object_access: true,
			async handler(ctx) {
				const { node_id, name } = ctx.params;
				const node = await this.getNode(node_id);
				await this.assertNodePermission(ctx, node, "manage");
				return this.db("storage.nodes")
					.update({
						name,
					})
					.where({ node_id })
					.returning("*")
					.then(([renamed]) => this.hydrateNodeVisibility(renamed))
					.then(renamed => {
						this.vfsChanged(ctx, null, {
							event: "rename",
							renamed,
						});
						this.vfsNodeChanged(ctx, null, {
							old_parent_id: node.parent_id,
							...renamed,
						});
						return renamed;
					});
			},
		},
		vfsMoveNode: {
			graphql: {
				mutation: "vfsMoveNode(node_id:Int!,destination_id:Int!):VFSNode",
			},
			object_access: true,
			async handler(ctx) {
				const { node_id, destination_id } = ctx.params;
				this.requireCapability(ctx, "move");
				const target = await this.getNode(node_id);
				const dest = await this.getNode(destination_id);
				await this.assertNodePermission(ctx, target, "manage");
				await this.assertNodePermission(ctx, dest, "write");
				if (!target) throw new Error("Destination doesn't exists !");
				if (dest.type !== "DIR")
					throw new Error(`Distination is not a directory ( ${target.type} )`);
				const wrong = (await this.getDescendantNodeIds(node_id)) as number[];
				if (wrong.includes(destination_id)) throw new Error("Cannot create recursive !");
				return this.db("storage.nodes")
					.update({
						parent_id: destination_id,
						sub: ctx.meta.user?.sub || null,
					})
					.where({ node_id })
					.whereRaw(`parent_id is not null`)
					.returning("*")
					.then(([v]) => v)
					.then(moved => this.hydrateNodeVisibility(moved))
					.then(moved => {
						this.vfsChanged(ctx, null, {
							event: "move",
							moved,
						});
						this.vfsNodeChanged(ctx, null, {
							old_parent_id: target.parent_id,
							...moved,
						});
						return moved;
					});
			},
		},
		vfsNodeAcl: {
			graphql: {
				query: "vfsNodeAcl(node_id:Int!):[VFSNodeACL!]",
			},
			object_access: true,
			async handler(ctx) {
				const node = await this.getNode(ctx.params.node_id);
				await this.assertNodePermission(ctx, node, "manage");
				return this.getNodeAclEntries(node.node_id);
			},
		},
		vfsAclNodes: {
			graphql: {
				query: "vfsAclNodes(scope:String,first:Int,max:Int):VFSAclIndexedNodePage!",
			},
			object_access: true,
			async handler(ctx) {
				const { scope } = ctx.params;
				const { first, max } = this.normalizeAclPage(ctx.params.first, ctx.params.max);
				const rows = await this.db("storage.nodes as n")
					.select("n.*")
					.whereExists(function () {
						this.select(this.client.raw("1"))
							.from("storage.node_acl as acl")
							.whereRaw("acl.node_id = n.node_id");
					})
					.modify(query => {
						if (scope) {
							query.where({ "n.scope": scope });
						}
					})
					.orderBy([
						{ column: "n.scope", order: "asc" },
						{ column: "n.type", order: "asc" },
						{ column: "n.name", order: "asc" },
					]);

				const visibleRows = await this.filterNodesByAclIndexPermission(ctx, rows);
				const hydratedRows = await this.hydrateNodesVisibility(visibleRows);
				const mappedRows = await Promise.all(
					hydratedRows.map(async node => ({
						node_id: node.node_id,
						public_url: node.public_url,
						parent_id: node.parent_id,
						name: node.name,
						type: node.type,
						path: await this.getNodePathString(node.node_id),
						scope: node.scope,
						visibility: node.visibility,
						effectiveVisibility: node.effectiveVisibility,
						acl_count: node.acl_count,
						has_acl: node.has_acl,
						has_tiles: Boolean(node.has_tiles),
					}))
				);

				return this.paginateAclItems(mappedRows, first, max);
			},
		},
		vfsAclRuleIndex: {
			graphql: {
				query: "vfsAclRuleIndex(scope:String,first:Int,max:Int):VFSAclRuleIndexPage!",
			},
			object_access: true,
			async handler(ctx) {
				const { scope } = ctx.params;
				const { first, max } = this.normalizeAclPage(ctx.params.first, ctx.params.max);
				const rows = await this.db("storage.nodes as n")
					.join("storage.node_acl as acl", "acl.node_id", "n.node_id")
					.select("n.*", "acl.principal_type", "acl.principal_id", "acl.permission", "acl.effect")
					.modify(query => {
						if (scope) {
							query.where({ "n.scope": scope });
						}
					})
					.orderBy([
						{ column: "acl.principal_type", order: "asc" },
						{ column: "acl.principal_id", order: "asc" },
						{ column: "acl.effect", order: "asc" },
						{ column: "n.name", order: "asc" },
					]);

				const visibleRows = await this.filterNodePayloadsByAclIndexPermission(ctx, rows);
				const grouped = new Map<string, any>();

				for (const row of visibleRows) {
					const key = `${row.principal_type}::${row.principal_id}::${row.effect}`;
					const existing = grouped.get(key) || {
						principal_type: row.principal_type,
						principal_id: row.principal_id,
						effect: row.effect,
						permissions: new Set<string>(),
						nodes: new Map<number, any>(),
					};
					existing.permissions.add(row.permission);
					existing.nodes.set(row.node_id, row);
					grouped.set(key, existing);
				}

				const result = await Promise.all(
					Array.from(grouped.values()).map(async group => {
						const nodes = await Promise.all(
							Array.from(group.nodes.values()).map(async row => {
								const hydrated = await this.hydrateNodeVisibility(row);
								return {
									node_id: hydrated.node_id,
									public_url: hydrated.public_url,
									parent_id: hydrated.parent_id,
									name: hydrated.name,
									type: hydrated.type,
									path: await this.getNodePathString(hydrated.node_id),
									scope: hydrated.scope,
									visibility: hydrated.visibility,
									effectiveVisibility: hydrated.effectiveVisibility,
									has_tiles: Boolean(hydrated.has_tiles),
								};
							})
						);

						return {
							principal_type: group.principal_type,
							principal_id: group.principal_id,
							effect: group.effect,
							permissions: Array.from(group.permissions).sort(),
							nodes,
						};
					})
				);

				return this.paginateAclItems(result, first, max);
			},
		},
		vfsTileNodes: {
			graphql: {
				query: "vfsTileNodes(scope:String,first:Int,max:Int):VFSTileIndexedNodePage!",
			},
			object_access: true,
			async handler(ctx) {
				const { scope } = ctx.params;
				const { first, max } = this.normalizeAclPage(ctx.params.first, ctx.params.max);
				const rows = await this.db("storage.nodes as n")
					.join("storage.node_tiles as t", "t.node_id", "n.node_id")
					.select(
						"n.*",
						"t.bucket_name",
						"t.dzi_object_name",
						"t.tile_prefix",
						"t.created_at",
						"t.updated_at"
					)
					.where({ "n.type": "FILE" })
					.modify(query => {
						if (scope) {
							query.where({ "n.scope": scope });
						}
					})
					.orderBy([
						{ column: "n.scope", order: "asc" },
						{ column: "n.name", order: "asc" },
					]);

				const visibleRows = await this.filterNodePayloadsByPermission(ctx, rows, "read");
				const result = await Promise.all(
					visibleRows.map(async row => {
						const hydrated = await this.hydrateNodeVisibility(row);
						return {
							node_id: hydrated.node_id,
							public_url: hydrated.public_url,
							parent_id: hydrated.parent_id,
							name: hydrated.name,
							type: hydrated.type,
							path: await this.getNodePathString(hydrated.node_id),
							scope: hydrated.scope,
							visibility: hydrated.visibility,
							effectiveVisibility: hydrated.effectiveVisibility,
							has_tiles: true,
							bucket_name: row.bucket_name,
							dzi_object_name: row.dzi_object_name,
							tile_prefix: row.tile_prefix,
							created_at: row.created_at,
							updated_at: row.updated_at,
						};
					})
				);

				return this.paginateAclItems(result, first, max);
			},
		},
		vfsTileRecords: {
			graphql: {
				query: "vfsTileRecords(scope:String,first:Int,max:Int):VFSTileRecordPage!",
			},
			object_access: true,
			async handler(ctx) {
				const { scope } = ctx.params;
				const { first, max } = this.normalizeAclPage(ctx.params.first, ctx.params.max);
				const rows = await this.db("storage.nodes as n")
					.join("storage.node_tiles as t", "t.node_id", "n.node_id")
					.select(
						"n.*",
						"t.bucket_name",
						"t.dzi_object_name",
						"t.tile_prefix",
						"t.created_at",
						"t.updated_at"
					)
					.where({ "n.type": "FILE" })
					.modify(query => {
						if (scope) {
							query.where({ "n.scope": scope });
						}
					})
					.orderBy([
						{ column: "t.updated_at", order: "desc" },
						{ column: "n.name", order: "asc" },
					]);

				const visibleRows = await this.filterNodePayloadsByPermission(ctx, rows, "read");
				const result = await Promise.all(
					visibleRows.map(async row => {
						const hydrated = await this.hydrateNodeVisibility(row);
						return {
							node_id: hydrated.node_id,
							public_url: hydrated.public_url,
							parent_id: hydrated.parent_id,
							name: hydrated.name,
							path: await this.getNodePathString(hydrated.node_id),
							scope: hydrated.scope,
							visibility: hydrated.visibility,
							effectiveVisibility: hydrated.effectiveVisibility,
							has_tiles: true,
							bucket_name: row.bucket_name,
							dzi_object_name: row.dzi_object_name,
							tile_prefix: row.tile_prefix,
							created_at: row.created_at,
							updated_at: row.updated_at,
						};
					})
				);

				return this.paginateAclItems(result, first, max);
			},
		},
		vfsDeleteTiles: {
			graphql: {
				mutation: "vfsDeleteTiles(node_id:Int!):Boolean!",
			},
			object_access: true,
			async handler(ctx) {
				const { node_id } = ctx.params;
				const node = await this.getNode(node_id);
				await this.assertNodePermission(ctx, node, "manage");
				await ctx.call("minio.deleteTilesByNodeId", { nodeId: node_id });
				return true;
			},
		},
		vfsSetNodeAcl: {
			graphql: {
				mutation: "vfsSetNodeAcl(node_id:Int!,entries:[VFSNodeACLInput!]!):[VFSNodeACL!]",
			},
			object_access: true,
			async handler(ctx) {
				const { node_id, entries = [] } = ctx.params;
				const node = await this.getNode(node_id);
				await this.assertNodePermission(ctx, node, "manage");
				await this.db("storage.node_acl").where({ node_id }).delete();
				if (entries.length) {
					await this.db("storage.node_acl").insert(
						entries.map(entry => ({
							node_id,
							principal_type: entry.principal_type,
							principal_id: entry.principal_id,
							permission: entry.permission,
							effect: entry.effect,
						}))
					);
				}
				const acl = await this.getNodeAclEntries(node_id);
				this.vfsChanged(ctx, null, {
					event: "acl",
					node_id,
					acl,
				});
				return acl;
			},
		},
		vfsSetNodeVisibility: {
			graphql: {
				mutation: "vfsSetNodeVisibility(node_id:Int!,visibility:VFSVisibility!):VFSNode",
			},
			object_access: true,
			async handler(ctx) {
				const { node_id, visibility } = ctx.params;
				const node = await this.getNode(node_id);
				await this.assertNodePermission(ctx, node, "manage");
				await this.db("storage.nodes").where({ node_id }).update({ visibility });
				await this.syncSubtreeStorageVisibility(ctx, node_id);
				await ctx.call("minio.syncTilesVisibility", { nodeId: node_id }).catch(() => null);
				const updated = await this.hydrateNodeVisibility(await this.getNode(node_id));
				this.vfsChanged(ctx, null, {
					event: "visibility",
					node_id,
					visibility,
					node: updated,
				});
				this.vfsNodeChanged(ctx, null, {
					old_parent_id: node.parent_id,
					...updated,
				});
				return updated;
			},
		},
		resolveAccess: {
			visibility: "protected",
			params: {
				node_id: { type: "number", optional: true },
				ref: { type: "string", optional: true },
				permission: "string",
			},
			async handler(ctx) {
				const node = ctx.params.node_id
					? await this.getNode(ctx.params.node_id)
					: await this.getNodeByRef(ctx.params.ref);
				if (!node) {
					return {
						allowed: false,
						node: null,
						effectiveVisibility: "private",
					};
				}
				return this.evaluateNodePermission(ctx, node, ctx.params.permission);
			},
		},
		resolveEffectiveVisibility: {
			visibility: "protected",
			params: {
				node_id: "number",
			},
			async handler(ctx) {
				const node = await this.getNode(ctx.params.node_id);
				if (!node) {
					return "private";
				}
				return this.getEffectiveVisibility(node);
			},
		},
		resolveVFSNode_file: {
			async handler(ctx) {
				const node = await this.getNode(ctx.params.node_id);
				if (!node?.hash) {
					return null;
				}
				return ctx.call("minio.resolveFileRef", {
					ref: node.hash,
					name: node.name,
				});
			},
		},

		vfsGetPathIds: {
			graphql: {
				query: "vfsGetIdsToNode(target_id:Int!):[VFSNodePath!]",
			},
			async handler(ctx) {
				const node = await this.getNode(ctx.params.target_id);
				if (!node) {
					return [];
				}

				await this.assertNodePermission(ctx, node, "read");
				this.vfsDebug(ctx, "vfsGetPathIds", {
					target_id: ctx.params.target_id,
				});
				return this.getNodePath(ctx.params.target_id);
			},
		},

		resolveVFSDir_children: {
			async handler(ctx) {
				const { node_id } = ctx.params;
				this.vfsDebug(ctx, "resolveVFSDir_children", {
					node_id,
				});
				const rows = await this.db("storage.nodes").where({ parent_id: node_id });
				const visibleRows = await this.filterNodesByPermission(ctx, rows, "list");
				return this.hydrateNodesVisibility(visibleRows);
			},
		},
		onNodeChanged: {
			graphql: {
				subscription: "vfsNodeChanged(node_id:Int!,parent_id:Int!):JSON",
				tags: [VFSEvents.vfsNodeChanged],
				filter: "vfs.filter.nodes",
			},
			handler(ctx) {
				this.vfsDebug(ctx, "subscription:onNodeChanged", {
					params: ctx.params,
				});
				return ctx.params.payload;
			},
		},

		onVFSChanged: {
			graphql: {
				subscription: "vfsChanged:JSON",
				tags: [VFSEvents.vfsChanged],
				// filter: "sg.filter.user",
			},
			handler(ctx) {
				this.vfsDebug(ctx, "subscription:onVFSChanged", {
					params: ctx.params,
				});
				return ctx.params.payload;
			},
		},
		onVFSTilesChanged: {
			graphql: {
				subscription: "vfsTilesChanged:JSON",
				tags: [VFSEvents.vfsTilesChanged],
			},
			handler(ctx) {
				this.vfsDebug(ctx, "subscription:onVFSTilesChanged", {
					params: ctx.params,
				});
				return ctx.params.payload;
			},
		},

		"filter.nodes": {
			handler(ctx) {
				const { node_id, parent_id, payload: p } = ctx.params;
				const accepted =
					node_id === -1 ||
					parent_id === -1 ||
					node_id === p.parent_id ||
					node_id === p.old_parent_id;
				this.vfsDebug(ctx, "subscription:filter.nodes", {
					node_id,
					parent_id,
					payload_parent_id: p?.parent_id ?? null,
					payload_old_parent_id: p?.old_parent_id ?? null,
					accepted,
				});
				return accepted;
			},
		},
	},
	methods: {
		normalizeAclPage(first?: number, max?: number) {
			const normalizedFirst = Number.isInteger(first) && first! >= 0 ? first! : 0;
			const normalizedMax = Number.isInteger(max) && max! > 0 ? Math.min(max!, 100) : 25;
			return {
				first: normalizedFirst,
				max: normalizedMax,
			};
		},
		normalizeSearchTreePage(first?: number, max?: number) {
			const normalizedFirst = Number.isInteger(first) && first! >= 0 ? first! : 0;
			const normalizedMax = Number.isInteger(max) && max! > 0 ? Math.min(max!, 1000) : 500;
			return {
				first: normalizedFirst,
				max: normalizedMax,
			};
		},
		normalizeDirectorySortField(value?: string) {
			return value === "size" ? "size" : "name";
		},
		sortVfsDirectoryEntries(items = [], field = "name", order = "asc") {
			const direction = order === "desc" ? -1 : 1;
			const collator = new Intl.Collator("ru", {
				numeric: true,
				sensitivity: "base",
			});
			return [...items].sort((left, right) => {
				if (left.type !== right.type) {
					return left.type === "DIR" ? -1 : 1;
				}

				if (field === "size" && left.type === "FILE" && right.type === "FILE") {
					const sizeDiff = (left.size || 0) - (right.size || 0);
					if (sizeDiff !== 0) {
						return sizeDiff * direction;
					}
				}

				return collator.compare(left.name || "", right.name || "") * direction;
			});
		},
		paginateAclItems(items = [], first = 0, max = 25) {
			const total = items.length;
			const pageItems = items.slice(first, first + max);
			return {
				first,
				max,
				total,
				hasMore: first + pageItems.length < total,
				items: pageItems,
			};
		},
		vfsDebug(ctx, event: string, payload = {}) {
			if (process.env.VFS_DEBUG !== "true") {
				return;
			}
			this.logger.info(`[VFS_DEBUG] ${event}`, payload);
		},
		hasRuleMatch(user, rule) {
			const roles = user?.roles || [];
			const groups = user?.groups || [];
			const hasRole = rule?.roles?.length ? rule.roles.some(role => roles.includes(role)) : false;
			const hasGroup = rule?.groups?.length
				? rule.groups.some(group => groups.includes(group))
				: false;
			return hasRole || hasGroup;
		},
		isVfsAdmin(user) {
			return this.hasRuleMatch(user, VFS_ADMIN_ACCESS);
		},
		requireCapability(ctx, capability: string) {
			if (isInternalCall(ctx)) {
				return;
			}
			if (this.isVfsAdmin(ctx.meta.user)) {
				return;
			}
			const capabilities = resolveVfsCapabilities(ctx.meta.user);
			if (!capabilities.includes(capability)) {
				throw new MoleculerErrors.MoleculerClientError(
					`VFS capability '${capability}' is required`,
					403,
					"VFS_CAPABILITY_REQUIRED"
				);
			}
		},
		normalizeVisibility(visibility?: string | null) {
			if (visibility === "public" || visibility === "private" || visibility === "inherit") {
				return visibility;
			}
			return "inherit";
		},
		getPermissionAliases(permission: string) {
			switch (permission) {
				case "list":
					return ["list", "read", "manage"];
				case "read":
					return ["read", "manage"];
				case "write":
					return ["write", "manage"];
				case "delete":
					return ["delete", "manage"];
				case "manage":
					return ["manage"];
				default:
					return [permission, "manage"];
			}
		},
		matchAclEntry(user, entry) {
			switch (entry.principal_type) {
				case "user":
					return Boolean(user?.sub && entry.principal_id === user.sub);
				case "role":
					return Boolean(user?.roles?.includes(entry.principal_id));
				case "group":
					return Boolean(user?.groups?.includes(entry.principal_id));
				default:
					return false;
			}
		},
		getNodePath(node_id: number) {
			return this.db
				.raw(`select * from storage."vfsGetNodePath"(?) as path`, [node_id])
				.then(({ rows }) => {
					return rows;
				});
		},
		async getNodePathString(node_id: number) {
			const rows = await this.getNodePath(node_id);
			if (!rows?.length) {
				return "/";
			}
			const parts = rows.map(({ name }) => name).filter(name => name && name !== "/");
			return `/${parts.join("/")}`;
		},
		async getNodeAncestors(node_id: number) {
			const pathRows = await this.getNodePath(node_id);
			const nodeIds = pathRows?.map(({ node_id: pathNodeId }) => pathNodeId) || [];
			if (!nodeIds.length) {
				return [];
			}
			const nodes = await this.db("storage.nodes").whereIn("node_id", nodeIds).select("*");
			const nodeMap = new Map(nodes.map(node => [node.node_id, node]));
			return nodeIds.map(id => nodeMap.get(id)).filter(Boolean);
		},
		getNodeAclEntries(node_id: number) {
			return this.db("storage.node_acl")
				.where({ node_id })
				.orderBy([
					{ column: "principal_type", order: "asc" },
					{ column: "principal_id", order: "asc" },
					{ column: "permission", order: "asc" },
				]);
		},
		async getNodeAclCounts(nodeIds = []) {
			const normalizedIds = _.uniq((nodeIds || []).filter(Boolean));
			if (!normalizedIds.length) {
				return new Map<number, number>();
			}

			const rows = await this.db("storage.node_acl")
				.select("node_id")
				.count("* as count")
				.whereIn("node_id", normalizedIds)
				.groupBy("node_id");

			return new Map(
				rows.map(row => [
					Number(row.node_id),
					typeof row.count === "string" ? parseInt(row.count, 10) : Number(row.count || 0),
				])
			);
		},
		async getNodeTileFlags(nodeIds = []) {
			const normalizedIds = _.uniq((nodeIds || []).filter(Boolean));
			if (!normalizedIds.length) {
				return new Map<number, boolean>();
			}

			const rows = await this.db("storage.node_tiles")
				.select("node_id")
				.whereIn("node_id", normalizedIds);

			return new Map(rows.map(row => [Number(row.node_id), true]));
		},
		async getNodePreviewFlags(nodeIds = []) {
			const normalizedIds = _.uniq((nodeIds || []).filter(Boolean));
			if (!normalizedIds.length) {
				return new Map<number, boolean>();
			}

			const rows = await this.db("storage.node_preview")
				.distinct("node_id")
				.whereIn("node_id", normalizedIds);

			return new Map(rows.map(row => [Number(row.node_id), true]));
		},
		async getInheritedAclEntries(node_id: number) {
			const ancestors = await this.getNodeAncestors(node_id);
			const ancestorIds = ancestors.map(node => node.node_id);
			if (!ancestorIds.length) {
				return [];
			}
			return this.db("storage.node_acl").whereIn("node_id", ancestorIds).select("*");
		},
		async getEffectiveVisibility(nodeOrId) {
			const node = typeof nodeOrId === "number" ? await this.getNode(nodeOrId) : nodeOrId;
			if (!node) {
				return "private";
			}
			const ancestors = await this.getNodeAncestors(node.node_id);
			let effectiveVisibility = "private";
			for (const ancestor of ancestors) {
				const visibility = this.normalizeVisibility(ancestor.visibility);
				if (visibility !== "inherit") {
					effectiveVisibility = visibility;
				}
			}
			return effectiveVisibility;
		},
		async hydrateNodeVisibility(node) {
			if (!node) {
				return node;
			}
			const aclCount = (await this.getNodeAclCounts([node.node_id])).get(node.node_id) || 0;
			const hasTiles = (await this.getNodeTileFlags([node.node_id])).get(node.node_id) || false;
			const hasPreview = (await this.getNodePreviewFlags([node.node_id])).get(node.node_id) || false;
			return {
				...node,
				visibility: this.normalizeVisibility(node.visibility),
				effectiveVisibility: await this.getEffectiveVisibility(node),
				acl_count: aclCount,
				has_acl: aclCount > 0,
				has_tiles: hasTiles,
				has_preview: hasPreview,
			};
		},
		async hydrateNodesVisibility(nodes = []) {
			const aclCounts = await this.getNodeAclCounts((nodes || []).map(node => node.node_id));
			const tileFlags = await this.getNodeTileFlags((nodes || []).map(node => node.node_id));
			const previewFlags = await this.getNodePreviewFlags((nodes || []).map(node => node.node_id));
			return Promise.all(
				(nodes || []).map(async node => {
					const aclCount = aclCounts.get(node.node_id) || 0;
					return {
						...node,
						visibility: this.normalizeVisibility(node.visibility),
						effectiveVisibility: await this.getEffectiveVisibility(node),
						acl_count: aclCount,
						has_acl: aclCount > 0,
						has_tiles: tileFlags.get(node.node_id) || false,
						has_preview: previewFlags.get(node.node_id) || false,
					};
				})
			);
		},
		async evaluateNodePermission(ctx, nodeOrId, permission: string) {
			const node = typeof nodeOrId === "number" ? await this.getNode(nodeOrId) : nodeOrId;
			if (!node) {
				return {
					allowed: false,
					node: null,
					effectiveVisibility: "private",
				};
			}
			if (isInternalCall(ctx)) {
				return {
					allowed: true,
					node,
					effectiveVisibility: await this.getEffectiveVisibility(node),
				};
			}
			const user = ctx.meta?.user;
			const effectiveVisibility = await this.getEffectiveVisibility(node);
			if ((permission === "read" || permission === "list") && effectiveVisibility === "public") {
				return {
					allowed: true,
					node,
					effectiveVisibility,
				};
			}
			if (!user) {
				return {
					allowed: false,
					node,
					effectiveVisibility,
				};
			}
			if (this.isVfsAdmin(user) || (node.sub && user.sub === node.sub)) {
				return {
					allowed: true,
					node,
					effectiveVisibility,
				};
			}
			const aclEntries = await this.getInheritedAclEntries(node.node_id);
			const permissionAliases = this.getPermissionAliases(permission);
			const matchingEntries = aclEntries.filter(
				entry => permissionAliases.includes(entry.permission) && this.matchAclEntry(user, entry)
			);
			if (!aclEntries.length) {
				return {
					allowed: true,
					node,
					effectiveVisibility,
				};
			}
			if (matchingEntries.some(entry => entry.effect === "deny")) {
				return {
					allowed: false,
					node,
					effectiveVisibility,
				};
			}
			if (matchingEntries.some(entry => entry.effect === "allow")) {
				return {
					allowed: true,
					node,
					effectiveVisibility,
				};
			}
			return {
				allowed: false,
				node,
				effectiveVisibility,
			};
		},
		async assertNodePermission(ctx, nodeOrId, permission: string) {
			const access = await this.evaluateNodePermission(ctx, nodeOrId, permission);
			if (!access.allowed) {
				throw new MoleculerErrors.MoleculerClientError(
					`Access denied for VFS ${permission}`,
					403,
					"FORBIDDEN"
				);
			}
			return access;
		},
		async filterNodesByPermission(ctx, nodes = [], permission = "read") {
			const results = await Promise.all(
				(nodes || []).map(async node => ({
					node,
					access: await this.evaluateNodePermission(ctx, node, permission),
				}))
			);
			return results.filter(({ access }) => access.allowed).map(({ node }) => node);
		},
		async filterNodePayloadsByPermission(ctx, rows = [], permission = "read") {
			const results = await Promise.all(
				(rows || []).map(async row => ({
					row,
					access: await this.evaluateNodePermission(ctx, row.node_id, permission),
				}))
			);
			return results.filter(({ access }) => access.allowed).map(({ row }) => row);
		},
		async filterNodesByAclIndexPermission(ctx, nodes = []) {
			const results = await Promise.all(
				(nodes || []).map(async node => ({
					node,
					access: await this.evaluateNodePermission(
						ctx,
						node,
						node.type === "DIR" ? "list" : "read"
					),
				}))
			);
			return results.filter(({ access }) => access.allowed).map(({ node }) => node);
		},
		async filterNodePayloadsByAclIndexPermission(ctx, rows = []) {
			const results = await Promise.all(
				(rows || []).map(async row => ({
					row,
					access: await this.evaluateNodePermission(
						ctx,
						row.node_id,
						row.type === "DIR" ? "list" : "read"
					),
				}))
			);
			return results.filter(({ access }) => access.allowed).map(({ row }) => row);
		},
		async resolveVfsFileResult(ctx, node) {
			const file = node.hash
				? await ctx.call("minio.resolveFileRef", {
						ref: node.hash,
						name: node.name,
					})
				: null;
			const path = await this.getNodePathString(node.node_id);
			const effectiveVisibility = await this.getEffectiveVisibility(node);
			return {
				name: node.name,
				node_id: node.node_id,
				public_url: node.public_url,
				parent_id: node.parent_id,
				ctime: node.ctime,
				mtime: node.mtime,
				atime: node.atime,
				hash: node.hash,
				type: node.type,
				path,
				mime: file?.mime || null,
				size: file?.size || null,
				is_temp: file?.is_temp || false,
				created: file?.created || node.ctime,
				file_name: file?.name || node.name,
				visibility: this.normalizeVisibility(node.visibility),
				effectiveVisibility,
				acl_count: node.acl_count || 0,
				has_acl: Boolean(node.has_acl),
				has_tiles: Boolean(node.has_tiles),
				has_preview: Boolean(node.has_preview),
			};
		},
		async resolveVfsDirectoryEntryResult(ctx, node) {
			const file =
				node.type === "FILE" && node.hash
					? await ctx.call("minio.resolveFileRef", {
							ref: node.hash,
							name: node.name,
						})
					: null;
			const path = await this.getNodePathString(node.node_id);
			const effectiveVisibility = await this.getEffectiveVisibility(node);
			return {
				name: node.name,
				node_id: node.node_id,
				public_url: node.public_url,
				parent_id: node.parent_id,
				ctime: node.ctime,
				mtime: node.mtime,
				atime: node.atime,
				hash: node.hash,
				type: node.type,
				path,
				scope: node.scope,
				sub: node.sub || null,
				mime: file?.mime || null,
				size: file?.size || null,
				is_temp: file?.is_temp || false,
				created: file?.created || node.ctime,
				file_name: file?.name || node.name,
				visibility: this.normalizeVisibility(node.visibility),
				effectiveVisibility,
				acl_count: node.acl_count || 0,
				has_acl: Boolean(node.has_acl),
				has_tiles: Boolean(node.has_tiles),
				has_preview: Boolean(node.has_preview),
			};
		},

		getDescendantNodeIds(node_id: number) {
			return this.db
				.raw(`select * from storage."vfsGetDescendantNodeIds"(?) as ids`, [node_id])
				.then(({ rows }) => {
					return rows?.map(({ id }) => id);
				});
		},
		async createNode(params, ctx) {
			const { type, name, parent_id, scope } = params;
			const sub = ctx?.meta?.user?.sub || null;
			const parent = parent_id || (name !== "/" ? (await this.getRoot(ctx, scope)).node_id : null);
			const visibility = params.visibility || (name === "/" ? "private" : "inherit");
			return this.db("storage.nodes")
				.insert({
					type,
					name,
					parent_id: parent,
					public_url: randomUUID(),
					sub,
					scope,
					visibility,
				})
				.onConflict(["parent_id", "name"])
				.merge({
					type,
					name,
					parent_id: parent,
					sub,
					scope,
					visibility,
				})
				.returning("*")
				.then(([dir]) => dir);
		},
		getRoot(ctx, scope) {
			return this.db("storage.nodes")
				.where({ name: "/", scope })
				.first()
				.then(node => {
					if (!node) {
						return this.createNode({ type: "DIR", name: "/", scope }, ctx).then(root => {
							return root;
						});
					}
					return node;
				});
		},
		async ensureRoot(scope?: string) {
			const targetScope = typeof scope === "string" && scope.trim().length ? scope.trim() : "fs";
			const root = await this.getRoot(null, targetScope);
			this.logger.info(`Ensured VFS root for scope "${targetScope}"`, root?.node_id);
			return root;
		},
		getNode(node_id: number) {
			return this.db("storage.nodes").where({ node_id }).first();
		},
		getNodeByPublicUrl(public_url: string) {
			return this.db("storage.nodes").where({ public_url }).first();
		},
		getNodeByRef(ref: string) {
			return this.db("storage.nodes")
				.where({ hash: ref, type: "FILE" })
				.orderBy("node_id", "asc")
				.first();
		},
		async hasSysFileRefsTable() {
			const { rows } = await this.db.raw(`select to_regclass('sys.t_sys_files') as regclass`);
			return Boolean(rows?.[0]?.regclass);
		},
		async getNodeDeletionBlockers(nodes = []) {
			const fileNodes = (nodes || []).filter(node => node?.type === "FILE");
			if (!fileNodes.length) {
				return {
					file_ids: [],
					referenced_nodes: [],
					tiled_nodes: [],
				};
			}

			const nodeIds = _.uniq(fileNodes.map(node => Number(node.node_id)).filter(Boolean));
			const publicUrls = _.uniq(fileNodes.map(node => node.public_url).filter(Boolean));
			const tiledRows = await this.db("storage.node_tiles")
				.select("node_id")
				.whereIn("node_id", nodeIds);
			const tiledNodeIds = new Set(tiledRows.map(row => Number(row.node_id)));

			let referenceRows: Array<{ file_id: number | null; hash: string | null }> = [];
			if (publicUrls.length && (await this.hasSysFileRefsTable())) {
				referenceRows = await this.db("sys.t_sys_files")
					.select("file_id", "hash")
					.whereIn("hash", publicUrls);
			}

			const refsByHash = new Map<string, number[]>();
			for (const row of referenceRows) {
				const hash = String(row.hash || "");
				if (!hash) continue;
				const list = refsByHash.get(hash) || [];
				if (row.file_id != null) {
					list.push(Number(row.file_id));
				}
				refsByHash.set(hash, list);
			}

			const referenced_nodes = fileNodes
				.map(node => ({
					node_id: Number(node.node_id),
					name: node.name,
					public_url: node.public_url,
					file_ids: _.uniq(refsByHash.get(String(node.public_url || "")) || []).sort((a, b) => a - b),
				}))
				.filter(node => node.file_ids.length > 0);

			const tiled_nodes = fileNodes
				.filter(node => tiledNodeIds.has(Number(node.node_id)))
				.map(node => ({
					node_id: Number(node.node_id),
					name: node.name,
					public_url: node.public_url,
				}));

			return {
				file_ids: (_.uniq(referenced_nodes.flatMap(node => node.file_ids)) as number[]).sort(
					(a, b) => a - b
				),
				referenced_nodes,
				tiled_nodes,
			};
		},
		async assertNodesDeletionAllowed(nodes = []) {
			const blockers = await this.getNodeDeletionBlockers(nodes);
			if (!blockers.referenced_nodes.length && !blockers.tiled_nodes.length) {
				return blockers;
			}

			const reasons: string[] = [];
			if (blockers.referenced_nodes.length) {
				reasons.push(`node is referenced by sys.t_sys_files: ${blockers.file_ids.join(", ")}`);
			}
			if (blockers.tiled_nodes.length) {
				reasons.push("node has tiles, delete tiles first");
			}

			throw new MoleculerErrors.MoleculerClientError(
				reasons.join("; "),
				409,
				"VFS_DELETE_BLOCKED",
				blockers
			);
		},
		getStorageBucketByVisibility(visibility: string) {
			return config.minio.bucket;
		},
		async syncFileStorageVisibility(ctx, node) {
			if (!node?.hash) {
				return node;
			}
			const parsed = parseStorageRef(node.hash);
			if (!parsed || parsed.kind !== "minio") {
				return node;
			}
			const effectiveVisibility = await this.getEffectiveVisibility(node);
			const targetBucket = this.getStorageBucketByVisibility(effectiveVisibility);
			if (parsed.bucketName === targetBucket) {
				return {
					...node,
					effectiveVisibility,
				};
			}
			await ctx.call("minio.copyObject", {
				sourceBucket: parsed.bucketName,
				sourceObject: parsed.objectName,
				destBucket: targetBucket,
				destObject: parsed.objectName,
			});
			await ctx.call("minio.deleteByRef", { ref: parsed.raw });
			const nextRef = formatMinioStorageRef(targetBucket, parsed.objectName);
			const [updated] = await this.db("storage.nodes")
				.where({ node_id: node.node_id })
				.update({ hash: nextRef })
				.returning("*");
			return {
				...updated,
				effectiveVisibility,
			};
		},
		async syncSubtreeStorageVisibility(ctx, rootNodeId: number) {
			const descendantIds = await this.getDescendantNodeIds(rootNodeId);
			const nodeIds = _.uniq([rootNodeId, ...(descendantIds || [])]);
			const fileNodes = await this.db("storage.nodes")
				.whereIn("node_id", nodeIds)
				.andWhere({ type: "FILE" })
				.select("*");
			return Promise.all(fileNodes.map(node => this.syncFileStorageVisibility(ctx, node)));
		},
		lookupNodeByName(target: string) {
			const parts = this.pathParts(target);
			const lookupOne = async (parent_id?: number) => {
				const name = parts.shift();
				const current = await this.db("storage.nodes")
					.where(function () {
						this.where({ name });
						if (parent_id) this.where({ parent_id });
					})
					.first();
				if (current) {
					if (parts.length > 0) return lookupOne(current.node_id);
					return current;
				}
				return undefined;
			};
			return lookupOne();
		},
		pathParts(pathStr: string): string[] {
			const parts = pathStr.split("/").filter(p => p?.length > 0);
			if (!parts.length) parts.push("/");
			return parts;
		},
		isAuth(ctx) {
			if (!ctx.meta?.user?.sub) throw new Error("Вы вышли из системы");
		},
	},
};

export default vfsService;
