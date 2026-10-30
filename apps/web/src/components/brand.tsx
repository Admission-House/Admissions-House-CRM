import Image from 'next/image';

/** The Admissions House mark. The picture is the client's own logo file. */
export function Logo({ size = 40, className }: { size?: number; className?: string }) {
  return <Image src="/brand/logo-mark.png" alt="Admissions House" width={size} height={size} priority className={className} style={{ width: size, height: size }} />;
}
