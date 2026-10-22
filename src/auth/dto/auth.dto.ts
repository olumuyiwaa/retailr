import { Transform } from "class-transformer";
import { IsEmail, IsIn, IsOptional, IsString, Length, MaxLength, MinLength } from "class-validator";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class RegisterDto {
  @Transform(trim) @IsString() @Length(1, 100, { message: "Please enter your name." }) ownerName: string;
  @Transform(trim) @IsEmail({}, { message: "Enter a valid email address." }) @MaxLength(254) email: string;
  @IsString() @MinLength(8, { message: "Password must be at least 8 characters." }) @MaxLength(128) password: string;
  @Transform(trim) @IsString() @Length(1, 100, { message: "Please enter your business name." }) businessName: string;
  @Transform(trim) @IsString() @Length(1, 100) category: string;
  @Transform(trim) @IsString() @Length(1, 100, { message: "Please enter your country and city." }) country: string;
  @Transform(trim) @IsString() @Length(1, 100, { message: "Please enter your country and city." }) city: string;
  @Transform(trim) @IsOptional() @IsString() @MaxLength(40) phone?: string;
  @IsString({ message: "Please choose a plan." }) planId: string;
  @IsIn(["monthly", "yearly"]) cycle: "monthly" | "yearly";
  @Transform(trim) @IsOptional() @IsString() @MaxLength(20) couponCode?: string;
}

export class LoginDto {
  @Transform(trim) @IsString() email: string;
  @IsString() password: string;
}

export class RefreshDto {
  @IsString() refreshToken: string;
}

export class AcceptInviteDto {
  @IsString() @MaxLength(200) token: string;
  @IsString() @MinLength(8, { message: "Password must be at least 8 characters." }) @MaxLength(128) password: string;
}

export class ForgotPasswordDto {
  @Transform(trim) @IsString() @MaxLength(254) email: string;
}

export class ResetPasswordDto {
  @IsString() @MaxLength(200) token: string;
  @IsString() @MinLength(8, { message: "Password must be at least 8 characters." }) @MaxLength(128) password: string;
}

export class VerifyEmailDto {
  @IsString() @MaxLength(200) token: string;
}

export class ChangePasswordDto {
  @IsString() @MinLength(1, { message: "Enter your current password." }) @MaxLength(128) currentPassword: string;
  @IsString() @MinLength(8, { message: "Password must be at least 8 characters." }) @MaxLength(128) newPassword: string;
}

export class UpdateMeDto {
  @Transform(trim) @IsString() @Length(1, 100, { message: "Please enter your name." }) name: string;
}

export class DeleteAccountDto {
  @IsString() @MinLength(1, { message: "Enter your password to confirm." }) @MaxLength(128) password: string;
}

