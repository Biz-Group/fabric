import { ArrowUpRight, Sparkles } from "lucide-react";
import { ReleaseNotesMonthNav } from "@/features/release-notes/release-notes-month-nav";
import {
  monthlyReleaseNotes,
  type MonthlyReleaseNote,
  type ReleaseNoteItem,
} from "@/features/release-notes/release-notes-data";
import styles from "@/features/release-notes/release-notes.module.css";

function ReleaseList({ items }: { items: ReleaseNoteItem[] }) {
  return (
    <ol className={styles.releaseList}>
      {items.map((item, index) => (
        <li key={item.title} className={styles.releaseItem}>
          <span className={styles.itemIndex} aria-hidden="true">
            {String(index + 1).padStart(2, "0")}
          </span>
          <div>
            <h4 className={styles.itemTitle}>{item.title}</h4>
            <p className={styles.itemDescription}>{item.description}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

function ReleaseSection({
  title,
  items,
  tone,
}: {
  title: string;
  items: ReleaseNoteItem[];
  tone: "feature" | "enhancement";
}) {
  const Icon = tone === "feature" ? Sparkles : ArrowUpRight;

  return (
    <section className={styles.updateSection} data-tone={tone}>
      <header className={styles.sectionHeader}>
        <span className={styles.sectionIcon} aria-hidden="true">
          <Icon />
        </span>
        <h3>{title}</h3>
        <span className={styles.sectionCount}>{items.length}</span>
      </header>
      <ReleaseList items={items} />
    </section>
  );
}

function MonthRelease({
  release,
  latest,
}: {
  release: MonthlyReleaseNote;
  latest: boolean;
}) {
  return (
    <article
      id={release.id}
      className={styles.release}
      data-latest={latest ? "true" : undefined}
    >
      <header className={styles.releaseHeader}>
        <time
          className={styles.dateLockup}
          dateTime={`${release.year}-${release.monthNumber}`}
        >
          <span className={styles.dateCopy}>
            {release.shortMonth}
            <span>{release.year}</span>
          </span>
        </time>
        <div className={styles.releaseIntro}>
          {latest ? (
            <span className={styles.latestTag}>
              <span aria-hidden="true" />
              Latest release
            </span>
          ) : null}
          <h2>{release.headline}</h2>
          <p>{release.summary}</p>
        </div>
      </header>

      <div className={styles.updatesGrid}>
        <ReleaseSection
          title="New features"
          items={release.newFeatures}
          tone="feature"
        />
        <ReleaseSection
          title="Enhancements"
          items={release.enhancements}
          tone="enhancement"
        />
      </div>
    </article>
  );
}

export function ReleaseNotes() {
  const monthLinks = monthlyReleaseNotes.map(
    ({ id, shortMonth, year }) => ({
      id,
      shortMonth,
      year,
    }),
  );

  return (
    <div className={styles.journal}>
      <div className={styles.journalLayout}>
        <ReleaseNotesMonthNav months={monthLinks} />

        <section className={styles.archive} aria-label="Monthly releases">
          {monthlyReleaseNotes.map((release, index) => (
            <MonthRelease
              key={release.id}
              release={release}
              latest={index === 0}
            />
          ))}
          <footer className={styles.archiveEnd}>
            <span aria-hidden="true" />
            <p>That&apos;s the full story so far.</p>
          </footer>
        </section>
      </div>
    </div>
  );
}
