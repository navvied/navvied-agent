//! Ending a program and everything it started. A shell command the agent runs must not outlive the app.

#[cfg(unix)]
mod imp {
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    pub struct Tree;

    impl Tree {
        /// The child leads its own process group, so one signal reaches all of its descendants.
        pub fn prepare(cmd: &mut Command) {
            cmd.process_group(0);
            #[cfg(target_os = "linux")]
            // SAFETY: only an async-signal-safe call between fork and exec. If the app dies, the kernel ends the child.
            unsafe {
                cmd.pre_exec(|| {
                    libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                    Ok(())
                });
            }
        }

        pub fn adopt(_child: &Child) -> Tree {
            Tree
        }

        pub fn kill(&self, pid: u32) {
            // SAFETY: a negative pid addresses the process group that `prepare` created.
            unsafe {
                libc::kill(-(pid as i32), libc::SIGKILL);
            }
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::os::windows::io::AsRawHandle;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;

    /// A job object: when its handle closes, even by the app being killed, Windows ends every process in it.
    pub struct Tree(HANDLE);

    // SAFETY: a job handle is just a number the kernel owns; any thread may use it.
    unsafe impl Send for Tree {}
    unsafe impl Sync for Tree {}

    impl Tree {
        pub fn prepare(cmd: &mut Command) {
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        pub fn adopt(child: &Child) -> Tree {
            // SAFETY: plain Win32 calls with valid arguments; failure leaves a null job, and `kill` then does nothing more.
            unsafe {
                let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
                if !job.is_null() {
                    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
                    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info as *const _ as *const _, std::mem::size_of_val(&info) as u32);
                    AssignProcessToJobObject(job, child.as_raw_handle() as HANDLE);
                }
                Tree(job)
            }
        }

        pub fn kill(&self, _pid: u32) {
            if !self.0.is_null() {
                // SAFETY: the handle came from CreateJobObjectW and is still open.
                unsafe {
                    TerminateJobObject(self.0, 1);
                }
            }
        }
    }

    impl Drop for Tree {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: closing the handle we own, once. KILL_ON_JOB_CLOSE ends any process still inside.
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
    }
}

pub use imp::Tree;
