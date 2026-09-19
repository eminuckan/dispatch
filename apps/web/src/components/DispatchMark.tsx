import type { SVGProps } from "react";

export function DispatchMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="250 208 560 608" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M300 258H497C669 258 760 350 760 512S669 766 497 766H300V258ZM412 368V656H496C596 656 644 606 644 512S596 368 496 368H412Z"
      />
    </svg>
  );
}
