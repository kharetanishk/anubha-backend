import { Router } from "express";
import imageUpload from "../../middleware/multerConfig";
import { uploadImageToCloudinary } from "./upload.controller";
import { requireAuth } from "../../middleware/requireAuth";

const uploadRoutes = Router();

uploadRoutes.post(
  "/image",
  requireAuth,
  imageUpload.array("files", 10),
  uploadImageToCloudinary
);

export default uploadRoutes;
