import nodemailer from "nodemailer";
import { GQLSchema } from "@src/lib/moleculer";
import { DBMixin } from "@src/lib/mixins/db";
import { gql } from "@src/lib";
import { parseStorageRef } from "./mixins/s3/storage-ref";
import { Errors as MoleculerErrors } from "moleculer";

type VfsAccessResult = {
	allowed: boolean;
};

type ResolvedAttachmentFile = {
	name: string;
	mime: string;
};

const MailService: GQLSchema = {
	name: "mail",
	mixins: [DBMixin],
	settings: {
		graphql: {
			type: gql`
				input MailAttachment {
					public_url: UUID!
					title: String
				}
				input MailInput {
					to: [String!]!
					subject: String!
					body: String!
					attachments: [MailAttachment!]
				}
			`,
		},
	},
	dependencies: [],
	hooks: {
		before: {
			"*": ["withObjectVisible", "withObjectAccess"],
		},
	},
	actions: {
		// https://isco.pro/dev/api/auth/social?type=gitlab
		sendFull: {
			graphql: {
				mutation: "mailCreate(mail:MailInput!):JSON",
			},
			object_access: true,
			async handler(ctx) {
				const {
					mail: { to, subject, body, attachments },
				} = ctx.params;
				const createAttachments = async () => {
					if (!attachments) return undefined;

					return Promise.all(
						attachments.map(async item => {
							const node = await this.db("storage.nodes")
								.select("*")
								.where({ public_url: item.public_url, type: "FILE" })
								.first();

							if (!node?.hash) {
								throw new MoleculerErrors.MoleculerClientError(
									`Wrong attachment public_url ${item.public_url}, file not found`,
									404,
									"ATTACHMENT_NOT_FOUND"
								);
							}

							const access = (await ctx.call("vfs.resolveAccess", {
								node_id: node.node_id,
								permission: "read",
							})) as VfsAccessResult;

							if (!access?.allowed) {
								throw new MoleculerErrors.MoleculerClientError(
									`Access denied for attachment ${item.public_url}`,
									403,
									"ATTACHMENT_FORBIDDEN"
								);
							}

							const storageRef = parseStorageRef(node.hash);
							if (storageRef?.kind !== "minio") {
								throw new MoleculerErrors.MoleculerClientError(
									`Attachment ${item.public_url} is not backed by MinIO`,
									400,
									"ATTACHMENT_INVALID_BACKEND"
								);
							}

							const [fileInfo, content] = (await Promise.all([
								ctx.call("minio.resolveFileRef", {
									ref: node.hash,
									name: item.title || node.name,
								}),
								ctx.call("minio.getObject", {
									bucketName: storageRef.bucketName,
									objectName: storageRef.objectName,
								}),
							])) as [ResolvedAttachmentFile, Buffer];

							return {
								filename: item.title || fileInfo.name || node.name,
								content,
								contentType: fileInfo.mime,
							};
						})
					);
				};
				const files = await createAttachments();
				const transport = this.createTransport();
				return transport
					.sendMail({
						from: process.env.SMTP_USER,
						to: to.join(","),
						subject,
						text: body,
						html: body,
						attachments: files,
					})
					.then(res => {
						console.log(body);
						console.log("Feedback", res);
						return res;
					});
			},
		},
		send: {
			graphql: {
				mutation:
					"sendMail(to:String,subject:String,body:String,attachments:[MailAttachment!]):JSON",
			},
			// object_access: true,
			handler(ctx) {
				const { to, subject, body } = ctx.params;
				const transport = this.createTransport();
				return transport
					.sendMail({
						from: process.env.SMTP_USER,
						to,
						subject,
						text: body,
						html: body,
					})
					.then(res => {
						console.log(body);
						console.log("Feedback", res);
						return res;
					});
			},
		},
	},
	methods: {
		createTransport() {
			return nodemailer.createTransport({
				host: process.env.SMTP_HOST,
				port: process.env.SMTP_PORT,
				secure: true,
				auth: {
					user: process.env.SMTP_USER,
					pass: process.env.SMTP_PASS,
				},
				tls: {
					rejectUnauthorized: false,
				},
			});
		},
	},
};

export default MailService;
