import { useState, type InputHTMLAttributes } from "react";
import { EyeIcon, EyeOffIcon } from "./Icons";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
  secretLabel?: string;
};

export const PasswordInput = ({ secretLabel = "密码", disabled, ...props }: PasswordInputProps) => {
  const [visible, setVisible] = useState(false);

  return <span className="password-input">
    <input {...props} type={visible ? "text" : "password"} disabled={disabled} />
    <button type="button" className="password-input-toggle" disabled={disabled} aria-label={`${visible ? "隐藏" : "显示"}${secretLabel}`} aria-pressed={visible} title={`${visible ? "隐藏" : "显示"}${secretLabel}`} onClick={() => setVisible((value) => !value)}>
      {visible ? <EyeOffIcon /> : <EyeIcon />}
    </button>
  </span>;
};
