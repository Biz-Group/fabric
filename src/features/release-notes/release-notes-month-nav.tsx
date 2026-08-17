"use client";

import { useEffect, useRef, useState } from "react";
import styles from "@/features/release-notes/release-notes.module.css";

type ReleaseMonthLink = {
  id: string;
  shortMonth: string;
  year: string;
};

export function ReleaseNotesMonthNav({
  months,
}: {
  months: ReleaseMonthLink[];
}) {
  const [activeId, setActiveId] = useState(months[0]?.id ?? "");
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const syncRequestedHash = () => {
      const requestedId = window.location.hash.slice(1);
      if (months.some((month) => month.id === requestedId)) {
        setActiveId(requestedId);
      }
    };
    const hashFrame = window.requestAnimationFrame(syncRequestedHash);
    window.addEventListener("hashchange", syncRequestedHash);

    const sections = months
      .map((month) => document.getElementById(month.id))
      .filter((section): section is HTMLElement => section !== null);

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];

        if (visibleEntry) {
          const visibleId = visibleEntry.target.id;
          setActiveId(visibleId);
          const nextUrl = `${window.location.pathname}${window.location.search}#${visibleId}`;
          window.history.replaceState(window.history.state, "", nextUrl);
        }
      },
      {
        root: null,
        rootMargin: "-18% 0px -68% 0px",
        threshold: [0, 0.01],
      },
    );

    sections.forEach((section) => observer.observe(section));
    return () => {
      window.cancelAnimationFrame(hashFrame);
      window.removeEventListener("hashchange", syncRequestedHash);
      observer.disconnect();
    };
  }, [months]);

  useEffect(() => {
    if (!activeId) return;

    const list = listRef.current;
    const activeLink = list?.querySelector<HTMLElement>(
      `[data-month-id="${activeId}"]`,
    );
    if (!list || !activeLink) return;

    const targetLeft =
      activeLink.offsetLeft - list.clientWidth / 2 + activeLink.clientWidth / 2;
    list.scrollTo({ left: Math.max(0, targetLeft), behavior: "smooth" });
  }, [activeId]);

  return (
    <nav className={styles.monthNav} aria-label="Release note months">
      <p className={styles.monthNavLabel}>Journal index</p>
      <ul ref={listRef} className={styles.monthList}>
        {months.map((month, index) => {
          const active = month.id === activeId;
          return (
            <li key={month.id}>
              <a
                href={`#${month.id}`}
                className={styles.monthLink}
                data-active={active ? "true" : undefined}
                data-month-id={month.id}
                aria-current={active ? "location" : undefined}
                onClick={() => setActiveId(month.id)}
              >
                <span className={styles.navDate}>
                  <span>{month.shortMonth}</span>
                  <span className={styles.navYear}>{month.year}</span>
                </span>
                {index === 0 ? (
                  <span className={styles.navLatest}>Latest</span>
                ) : null}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
