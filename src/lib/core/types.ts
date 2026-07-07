export type LayerId = string;

export type ToolMode = "brush" | "eraser" | "smudge";

export type LayerMetadata = {
  id: LayerId;
  name: string;
  visible: boolean;
  locked: boolean;
};

export type ProjectLayerManifest = LayerMetadata & {
  image: string;
};

export type ProjectManifest = {
  format: "minipaint-project";
  version: 1;
  canvas: {
    width: number;
    height: number;
    background: "#ffffff";
    colorSpace: "srgb";
  };
  activeLayerId: LayerId | null;
  view: {
    zoom: number;
    offsetX: number;
    offsetY: number;
  };
  brush: {
    color: string;
    size: number;
  };
  layers: ProjectLayerManifest[];
};
