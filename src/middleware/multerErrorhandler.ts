import { Request, Response, NextFunction } from "express";
import multer from "multer";

export const multerErrorHandler = (
  err: any,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({
        error: "File too large! Maximum allowed size is 10MB.",
      });
    }

    return res.status(400).json({
      error: `Multer error: ${err.message}`,
    });
  }

  if (err.name === "MulterFileTypeError") {
    return res.status(400).json({
      error: "Invalid file type. Only JPG, JPEG, and PNG files are allowed.",
    });
  }

  next(err);
};
