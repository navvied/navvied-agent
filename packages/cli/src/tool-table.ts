/**
 * The tools a person switches on and off, as data: one row per tool the person knows by one name, in six categories, with the words the
 * owner approved for them. `names` are the engine's tools a row stands for (the terminal is Bash and the commands that go with it); an
 * empty list is a tool that does not exist yet, so its row is listed as unavailable until it does.
 */
export interface Category { id: string; title: string }

export const CATEGORIES: readonly Category[] = [
  { id: "work", title: "Work" },
  { id: "browse", title: "Browse & research" },
  { id: "plan", title: "Plan & coordinate" },
  { id: "memory", title: "Memory & knowledge" },
  { id: "create", title: "See, hear & create" },
  { id: "computer", title: "Control the computer" },
];

export interface ToolRow {
  id: string;
  category: string;
  names: readonly string[];
  title: string;
  about: string;
  /** Off until the person switches it on, and listed as experimental while it is. */
  experimental?: true;
}

export const TOOL_ROWS: readonly ToolRow[] = [
  { id: "files", category: "work", names: ["Read", "Write", "Edit", "MultiEdit", "apply_patch", "NotebookEdit", "Glob", "Grep"], title: "Files & Search", about: "Read, search and change files in the folder." },
  { id: "terminal", category: "work", names: ["Bash", "BashOutput", "BashInput", "KillShell"], title: "Terminal & Processes", about: "Run commands on this computer." },
  { id: "code", category: "work", names: ["ExecuteCode"], title: "Code Execution", about: "Run small programs to calculate or transform data.", experimental: true },
  { id: "web-search", category: "browse", names: ["WebSearch"], title: "Web Search", about: "Find pages about a question." },
  { id: "web-fetch", category: "browse", names: ["WebFetch"], title: "Web Fetch", about: "Read one page and give back its text." },
  { id: "browser", category: "browse", names: ["Browser"], title: "Browser Automation", about: "Drive a real browser: open, click, type, look." },
  { id: "ask", category: "plan", names: ["AskUserQuestion"], title: "Questions", about: "Ask you to choose before it goes on." },
  { id: "todo", category: "plan", names: ["TodoWrite"], title: "Task Planning", about: "Keep a list of steps and tick them off." },
  { id: "helpers", category: "plan", names: ["Agent"], title: "Helpers", about: "Hand a part of the task to another agent." },
  { id: "schedule", category: "plan", names: [], title: "Schedule", about: "Run a task later or every day." },
  { id: "memory", category: "memory", names: ["Remember"], title: "Memory", about: "Remember what matters between conversations." },
  { id: "session-search", category: "memory", names: ["Recall"], title: "Session Search", about: "Look back through earlier conversations." },
  { id: "skills", category: "memory", names: ["Skill", "SkillManage"], title: "Skills", about: "Use saved ways of doing a task." },
  { id: "vision", category: "create", names: [], title: "Vision", about: "Look at pictures and screenshots." },
  { id: "speech-to-text", category: "create", names: [], title: "Speech to Text", about: "Turn speech into text." },
  { id: "text-to-speech", category: "create", names: [], title: "Text to Speech", about: "Read a text aloud." },
  { id: "image", category: "create", names: [], title: "Image Generation", about: "Draw a picture from a description." },
  { id: "video-generation", category: "create", names: [], title: "Video Generation", about: "Make a few seconds of video." },
  { id: "video-analysis", category: "create", names: [], title: "Video Analysis", about: "Look through a video." },
  { id: "computer-use", category: "computer", names: [], title: "Computer Use", about: "Use the screen, mouse and keyboard." },
];

export const rowOf = (name: string): ToolRow | undefined => TOOL_ROWS.find((r) => r.names.includes(name));
