import { gql } from "@src/lib";

export default {
	settings: {
		graphql: {
			type: gql`
				enum VFSNodeType {
					DIR
					FILE
				}

				enum VFSVisibility {
					inherit
					public
					private
				}

				enum VFSAccessPrincipalType {
					role
					group
					user
				}

				enum VFSAccessPermission {
					read
					list
					write
					delete
					manage
				}

				enum VFSAccessEffect {
					allow
					deny
				}

				input VFSCreateNode {
					name: String!
					parent_id: Int
				}

				input VFSCreateFile {
					name: String!
					hash: String!
					parent_id: Int!
				}

				type VFSMinioFile {
					hash: String!
					storageRef: String!
					bucketName: String!
					objectName: String!
					path: String!
					name: String!
					mime: String!
					size: BigInt!
					created: String!
				}

				type VFSNode {
					name: String!
					node_id: Int!
					public_url: UUID
					parent_id: Int
					ctime: String
					mtime: String
					atime: String
					hash: String
					sub: UUID
					type: VFSNodeType
					file: VFSMinioFile
					scope: String!
					visibility: VFSVisibility!
					effectiveVisibility: VFSVisibility!
					acl_count: Int!
					has_acl: Boolean!
					has_tiles: Boolean!
					has_preview: Boolean!
					children: [VFSNode!]
				}

				type VFSAclIndexedNode {
					node_id: Int!
					public_url: UUID
					parent_id: Int
					name: String!
					type: VFSNodeType!
					path: String!
					scope: String!
					visibility: VFSVisibility!
					effectiveVisibility: VFSVisibility!
					acl_count: Int!
					has_acl: Boolean!
					has_tiles: Boolean!
					has_preview: Boolean!
				}

				type VFSAclIndexedNodePage {
					first: Int!
					max: Int!
					total: Int!
					hasMore: Boolean!
					items: [VFSAclIndexedNode!]!
				}

				type VFSNodeACL {
					acl_id: Int!
					node_id: Int!
					principal_type: VFSAccessPrincipalType!
					principal_id: String!
					permission: VFSAccessPermission!
					effect: VFSAccessEffect!
				}

				input VFSNodeACLInput {
					principal_type: VFSAccessPrincipalType!
					principal_id: String!
					permission: VFSAccessPermission!
					effect: VFSAccessEffect!
				}

				input VFSListInput {
					parent_id: Int
					type: VFSNodeType
				}

				input VFSLookupInput {
					mask: String
					type: VFSNodeType
				}
				input VFSListFilesInput {
					mask: String
					scope: String
					node_id: Int
					parent_id: Int
				}

				enum VFSDirectorySortField {
					name
					size
				}

				type VFSLookupResult {
					name: String!
					node_id: Int!
					parent_id: Int
					ctime: String
					mtime: String
					atime: String
					hash: String
					type: VFSNodeType
					path: String
					visibility: VFSVisibility
					effectiveVisibility: VFSVisibility
					acl_count: Int!
					has_acl: Boolean!
					has_tiles: Boolean!
					has_preview: Boolean!
				}

				type VFSFileResult {
					name: String!
					node_id: Int!
					public_url: UUID
					parent_id: Int
					ctime: String
					mtime: String
					atime: String
					hash: String
					type: VFSNodeType
					path: String
					mime: String
					size: BigInt
					is_temp: Boolean
					created: String
					file_name: String
					visibility: VFSVisibility
					effectiveVisibility: VFSVisibility
					acl_count: Int!
					has_acl: Boolean!
					has_tiles: Boolean!
					has_preview: Boolean!
				}

				type VFSDirectoryEntry {
					name: String!
					node_id: Int!
					public_url: UUID
					parent_id: Int
					ctime: String
					mtime: String
					atime: String
					hash: String
					type: VFSNodeType
					path: String
					scope: String!
					sub: UUID
					mime: String
					size: BigInt
					is_temp: Boolean
					created: String
					file_name: String
					visibility: VFSVisibility
					effectiveVisibility: VFSVisibility
					acl_count: Int!
					has_acl: Boolean!
					has_tiles: Boolean!
					has_preview: Boolean!
				}

				type VFSDirectoryEntryPage {
					first: Int!
					max: Int!
					total: Int!
					hasMore: Boolean!
					items: [VFSDirectoryEntry!]!
				}

				type VFSAclRuleIndexNode {
					node_id: Int!
					parent_id: Int
					name: String!
					type: VFSNodeType!
					path: String!
					scope: String!
					visibility: VFSVisibility!
					effectiveVisibility: VFSVisibility!
					has_tiles: Boolean!
				}

				type VFSTileIndexedNode {
					node_id: Int!
					public_url: UUID
					parent_id: Int
					name: String!
					type: VFSNodeType!
					path: String!
					scope: String!
					visibility: VFSVisibility!
					effectiveVisibility: VFSVisibility!
					has_tiles: Boolean!
					bucket_name: String!
					dzi_object_name: String!
					tile_prefix: String!
					created_at: String
					updated_at: String
				}

				type VFSTileIndexedNodePage {
					first: Int!
					max: Int!
					total: Int!
					hasMore: Boolean!
					items: [VFSTileIndexedNode!]!
				}

				type VFSTileRecord {
					node_id: Int!
					public_url: UUID
					parent_id: Int
					name: String!
					path: String!
					scope: String!
					visibility: VFSVisibility!
					effectiveVisibility: VFSVisibility!
					has_tiles: Boolean!
					bucket_name: String!
					dzi_object_name: String!
					tile_prefix: String!
					created_at: String
					updated_at: String
				}

				type VFSTileRecordPage {
					first: Int!
					max: Int!
					total: Int!
					hasMore: Boolean!
					items: [VFSTileRecord!]!
				}

				type VFSAclRuleIndexItem {
					principal_type: VFSAccessPrincipalType!
					principal_id: String!
					effect: VFSAccessEffect!
					permissions: [VFSAccessPermission!]!
					nodes: [VFSAclRuleIndexNode!]!
				}

				type VFSAclRuleIndexPage {
					first: Int!
					max: Int!
					total: Int!
					hasMore: Boolean!
					items: [VFSAclRuleIndexItem!]!
				}

				type VFSNodePath {
					node_id: Int!
					parent_id: Int
					name: String!
					childrens: [VFSNode]
					pos: Int
				}

				enum VFSSortOrder {
					asc
					desc
				}

				input VFSSort {
					column: String!
					order: VFSSortOrder!
				}

				input VFSNodeExistsInput {
					parent_id: Int
					name: String!
					type: VFSNodeType!
					scope: String!
				}
			`,
			resolvers: {
				VFSNode: {
					children: {
						action: "vfs.resolveVFSDir_children",
						rootParams: {
							node_id: "node_id",
							scope: "scope",
						},
					},
					file: {
						action: "vfs.resolveVFSNode_file",
						rootParams: {
							node_id: "node_id",
						},
					},
				},
				VFSNodePath: {
					childrens: {
						action: "vfs.vsNode",
						rootParams: {
							node_id: "parent_id",
						},
					},
				},
			},
		},
	},
};
