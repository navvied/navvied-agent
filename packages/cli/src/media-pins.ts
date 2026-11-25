import type { PinnedFile } from "./runtime.ts";

/**
 * What the setup of each media tool fetches, pinned: every file has the address of its release, the size and the SHA-256 it must have. A file that has another is deleted and
 * nothing of it is run. A system that is not listed gets "not available for this system yet": a hash that
 * was not read from the maker's own page and checked by downloading the file is never written here.
 */
export interface Piece extends PinnedFile {
  /** Where it is fetched from, whole. */
  url: string;
  /** An archive is taken apart (by this program) into a folder named after it; any other file is kept as it is. */
  unpack?: "tar.gz" | "zip";
}

/** The setup of one tool, for one kind of computer: what is fetched, the program inside it that is run, and how it is tried once. */
export interface Setup {
  pieces: readonly Piece[];
  /** Relative to the folder of the tool: the program the tool runs. */
  program: string;
  /** The program with these arguments must end well before the tool is called ready. */
  check: readonly string[];
}

export type SystemKey = "linux-x64";

const WHISPER = "https://github.com/ggml-org/whisper.cpp/releases/download/b5907";
const WHISPER_MODELS = "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1";
const PIPER = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2";
const VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/5ec43b186ef915a195d3ddbcfd9916e76c503c3f/en/en_US/lessac/low";
const SD = "https://github.com/leejet/stable-diffusion.cpp/releases/download/master-1043-3be2378";
const SD_MODELS = "https://huggingface.co/Green-Sky/SD-Turbo-GGUF/resolve/19a31586d02d64a73b4419bc193b3ecfaf38e1f0";
const VLM = "https://huggingface.co/ggml-org/SmolVLM-500M-Instruct-GGUF/resolve/72e986006ef53e37cdd3f6d4241c90b0f01df376";

/** Speech to text, text to speech and pictures: the programs of their makers, as released for Linux on a 64-bit processor, and the smallest sensible model of each. */
export const MEDIA_SETUPS = {
  "speech-to-text": {
    "linux-x64": {
      pieces: [
        { file: "whisper-bin-ubuntu-x64.tar.gz", url: `${WHISPER}/whisper-bin-ubuntu-x64.tar.gz`, sha256: "a6199027fe5b4239c84171d2bca4c0ff44ec86a515494d5a39b237b212d429bd", size: 10413708, unpack: "tar.gz" },
        { file: "ggml-tiny.en.bin", url: `${WHISPER_MODELS}/ggml-tiny.en.bin`, sha256: "921e4cf8686fdd993dcd081a5da5b6c365bfde1162e72b08d75ac75289920b1f", size: 77704715 },
      ],
      program: "whisper-bin-ubuntu-x64/whisper-bin-ubuntu-x64/whisper-cli",
      check: ["--help"],
    },
  },
  "text-to-speech": {
    "linux-x64": {
      pieces: [
        { file: "piper_linux_x86_64.tar.gz", url: `${PIPER}/piper_linux_x86_64.tar.gz`, sha256: "a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992", size: 26460462, unpack: "tar.gz" },
        { file: "en_US-lessac-low.onnx", url: `${VOICES}/en_US-lessac-low.onnx`, sha256: "f7d01dde371555732c4c314111ac79672b1a5ce2fc19266ab42178fd8df7f375", size: 63201294 },
        { file: "en_US-lessac-low.onnx.json", url: `${VOICES}/en_US-lessac-low.onnx.json`, sha256: "45754dfdebb3b8661c3fc564713772deec6e064feeb5b4e9594857dc7305193a", size: 4882 },
      ],
      program: "piper_linux_x86_64/piper/piper",
      check: ["--help"],
    },
  },
  image: {
    "linux-x64": {
      pieces: [
        { file: "sd-master-3be2378-bin-Linux-Ubuntu-24.04-x86_64.zip", url: `${SD}/sd-master-3be2378-bin-Linux-Ubuntu-24.04-x86_64.zip`, sha256: "01e1c773c1bc2a6276952f6dbd13294e58b7255c659b4a770086934c4e8fad3a", size: 27322680, unpack: "zip" },
        { file: "sd_turbo-f16-q8_0.gguf", url: `${SD_MODELS}/sd_turbo-f16-q8_0.gguf`, sha256: "d50be7655f0a554cf8041c145d88b210bd5f3c545423119dee62ae08cae51580", size: 2023745376 },
      ],
      program: "sd-master-3be2378-bin-Linux-Ubuntu-24.04-x86_64/sd-cli",
      check: ["--help"],
    },
  },
} as const satisfies Record<string, Partial<Record<SystemKey, Setup>>>;

/** The picture-reading model that goes with the model server of the program's own runtime (see `RUNTIME`): both files are the same on every system. */
export const VISION_FILES: readonly Piece[] = [
  { file: "SmolVLM-500M-Instruct-Q8_0.gguf", url: `${VLM}/SmolVLM-500M-Instruct-Q8_0.gguf`, sha256: "9d4612de6a42214499e301494a3ecc2be0abdd9de44e663bda63f1152fad1bf4", size: 436806912 },
  { file: "mmproj-SmolVLM-500M-Instruct-Q8_0.gguf", url: `${VLM}/mmproj-SmolVLM-500M-Instruct-Q8_0.gguf`, sha256: "d1eb8b6b23979205fdf63703ed10f788131a3f812c7b1f72e0119d5d81295150", size: 108783360 },
];

/** The settings a turbo model needs: one step, no guidance. */
export const IMAGE_SETTINGS = { steps: 1, cfg: 1 } as const;
