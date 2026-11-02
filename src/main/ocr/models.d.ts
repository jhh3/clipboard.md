/** @gutenye/ocr-models ships the PaddleOCR v4 ONNX files and no types. */
declare module '@gutenye/ocr-models/node' {
  const models: { detectionPath: string; recognitionPath: string; dictionaryPath: string }
  export default models
}
