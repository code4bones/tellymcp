import { GQLContext, GQLSchema } from "@src/lib/moleculer";
import multer from "multer";
import path from "path";

type UploderOptions = {
	uploadPath?: string;
	uploadEvent?: string;
};

const Uploader: GQLSchema = {
	name: "uploadMixin",
	methods: {
		uploadFile(ctx: GQLContext, opts: UploderOptions) {
			// докапываемся до Req & Res
			const { req, res } = ctx.options.parentCtx.params as any;
			const dir = path.join(opts?.uploadPath || path.join(process.cwd()), "/");
			if (!ctx) throw new Error(`Uploader parameters error: ctx missing !`);
			return new Promise((resolve, reject) => {
				try {
					const files = [];
					const storage = multer.diskStorage({
						destination: function (req, file, cb) {
							cb(null, dir);
						},
						filename: function (req, file, cb) {
							const { fieldname, originalname } = file;
							files.push({ fieldname, originalname: decodeURIComponent(originalname) });
							if (opts?.uploadEvent) {
								ctx.emit(opts.uploadEvent, file);
							}
							cb(null, decodeURIComponent(originalname));
						},
					});
					const upload = multer({ storage });
					const done = () => {
						resolve({ dir, files });
					};
					upload.any()(req, res, done);
				} catch (e) {
					reject(e);
				}
			});
		},
	},
};

export { Uploader };
