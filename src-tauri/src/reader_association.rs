use serde::Serialize;

const READER_BUNDLE_ID: &str = "com.murong.opslog.reader";
const TRC_CONTENT_TYPE: &str = "com.murong.opslog.trc";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrcAssociationStatus {
    supported: bool,
    associated: bool,
    platform: &'static str,
}

#[cfg(target_os = "macos")]
mod platform {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    use super::{READER_BUNDLE_ID, TRC_CONTENT_TYPE};

    const LS_ROLES_VIEWER: u32 = 0x0000_0002;

    #[link(name = "CoreServices", kind = "framework")]
    unsafe extern "C" {
        fn LSCopyDefaultRoleHandlerForContentType(
            content_type: CFStringRef,
            role: u32,
        ) -> CFStringRef;
        fn LSSetDefaultRoleHandlerForContentType(
            content_type: CFStringRef,
            role: u32,
            handler_bundle_id: CFStringRef,
        ) -> i32;
    }

    pub fn is_associated() -> bool {
        let content_type = CFString::new(TRC_CONTENT_TYPE);
        let handler = unsafe {
            LSCopyDefaultRoleHandlerForContentType(
                content_type.as_concrete_TypeRef(),
                LS_ROLES_VIEWER,
            )
        };
        if handler.is_null() {
            return false;
        }
        let handler = unsafe { CFString::wrap_under_create_rule(handler) };
        handler.to_string() == READER_BUNDLE_ID
    }

    pub fn associate() -> Result<(), String> {
        let content_type = CFString::new(TRC_CONTENT_TYPE);
        let bundle_id = CFString::new(READER_BUNDLE_ID);
        let status = unsafe {
            LSSetDefaultRoleHandlerForContentType(
                content_type.as_concrete_TypeRef(),
                LS_ROLES_VIEWER,
                bundle_id.as_concrete_TypeRef(),
            )
        };
        if status != 0 {
            return Err(format!("macOS 无法设置 .trc 默认应用（错误码 {status}）"));
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use std::ffi::c_void;

    use winreg::RegKey;
    use winreg::enums::HKEY_CURRENT_USER;

    const TRC_PROG_ID: &str = "OpsLogReader.trc";

    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHChangeNotify(event_id: i32, flags: u32, item1: *const c_void, item2: *const c_void);
    }

    pub fn is_associated() -> bool {
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        current_user
            .open_subkey(r"Software\Classes\.trc")
            .and_then(|key| key.get_value::<String, _>(""))
            .is_ok_and(|value| value == TRC_PROG_ID)
    }

    pub fn associate() -> Result<(), String> {
        let executable =
            std::env::current_exe().map_err(|error| format!("无法定位 Reader 程序：{error}"))?;
        let current_user = RegKey::predef(HKEY_CURRENT_USER);
        let (classes, _) = current_user
            .create_subkey(r"Software\Classes")
            .map_err(|error| format!("无法打开用户文件关联配置：{error}"))?;

        let (extension, _) = classes
            .create_subkey(".trc")
            .map_err(|error| format!("无法创建 .trc 文件关联：{error}"))?;
        extension
            .set_value("", &TRC_PROG_ID)
            .map_err(|error| format!("无法保存 .trc 文件关联：{error}"))?;
        extension
            .set_value("Content Type", &"text/plain")
            .map_err(|error| format!("无法保存 .trc 文件类型：{error}"))?;

        let (file_type, _) = classes
            .create_subkey(TRC_PROG_ID)
            .map_err(|error| format!("无法创建 Reader 文件类型：{error}"))?;
        file_type
            .set_value("", &"OpsLog TRC 日志文件")
            .map_err(|error| format!("无法保存 Reader 文件类型：{error}"))?;
        let (icon, _) = file_type
            .create_subkey("DefaultIcon")
            .map_err(|error| format!("无法配置 Reader 文件图标：{error}"))?;
        icon.set_value("", &format!("\"{}\",0", executable.display()))
            .map_err(|error| format!("无法保存 Reader 文件图标：{error}"))?;
        let (open_command, _) = file_type
            .create_subkey(r"shell\open\command")
            .map_err(|error| format!("无法配置 Reader 打开命令：{error}"))?;
        open_command
            .set_value("", &format!("\"{}\" \"%1\"", executable.display()))
            .map_err(|error| format!("无法保存 Reader 打开命令：{error}"))?;

        unsafe {
            SHChangeNotify(0x0800_0000, 0, std::ptr::null(), std::ptr::null());
        }
        Ok(())
    }
}

#[tauri::command]
pub fn get_trc_association_status() -> TrcAssociationStatus {
    #[cfg(target_os = "macos")]
    return TrcAssociationStatus {
        supported: true,
        associated: platform::is_associated(),
        platform: "macOS",
    };

    #[cfg(target_os = "windows")]
    return TrcAssociationStatus {
        supported: true,
        associated: platform::is_associated(),
        platform: "Windows",
    };

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    TrcAssociationStatus {
        supported: false,
        associated: false,
        platform: "unsupported",
    }
}

#[tauri::command]
pub fn associate_trc_files() -> Result<TrcAssociationStatus, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        platform::associate()?;
        return Ok(get_trc_association_status());
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    Err("当前平台暂不支持自动关联 .trc 文件".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_reader_specific_identifiers() {
        assert_eq!(READER_BUNDLE_ID, "com.murong.opslog.reader");
        assert_eq!(TRC_CONTENT_TYPE, "com.murong.opslog.trc");
    }
}
