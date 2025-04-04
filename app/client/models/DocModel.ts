/**
 * DocModel describes the observable models for all document data, including the built-in tables
 * (aka metatables), which are used in the Grist application itself (e.g. to render views).
 *
 * Since all data is structured as tables, we have several levels of models:
 * (1) DocModel maintains all tables
 * (2) MetaTableModel maintains data for a built-in table.
 * (3) DataTableModel maintains data for a user-defined table.
 * (4) RowModels (defined in {Data,Meta}TableModel.js) maintains data for one record in a table.
 *     For built-in tables, the records are defined in this module, below.
 */
import {KoArray} from 'app/client/lib/koArray';
import {KoSaveableObservable} from 'app/client/models/modelUtil';

import * as ko from 'knockout';
import memoize from 'lodash/memoize';

import * as koArray from 'app/client/lib/koArray';
import * as koUtil from 'app/client/lib/koUtil';
import DataTableModel from 'app/client/models/DataTableModel';
import {DocData} from 'app/client/models/DocData';
import {DocPageModel} from 'app/client/models/DocPageModel';
import {urlState} from 'app/client/models/gristUrlState';
import MetaRowModel from 'app/client/models/MetaRowModel';
import MetaTableModel from 'app/client/models/MetaTableModel';
import * as rowset from 'app/client/models/rowset';
import {TableData} from 'app/client/models/TableData';
import {isHiddenTable, isSummaryTable} from 'app/common/isHiddenTable';
import {canEdit} from 'app/common/roles';
import {RowFilterFunc} from 'app/common/RowFilterFunc';
import {schema, SchemaTypes} from 'app/common/schema';
import {ACLRuleRec, createACLRuleRec} from 'app/client/models/entities/ACLRuleRec';
import {ColumnRec, createColumnRec} from 'app/client/models/entities/ColumnRec';
import {createDocInfoRec, DocInfoRec} from 'app/client/models/entities/DocInfoRec';
import {createFilterRec, FilterRec} from 'app/client/models/entities/FilterRec';
import {createPageRec, PageRec} from 'app/client/models/entities/PageRec';
import {createShareRec, ShareRec} from 'app/client/models/entities/ShareRec';
import {createTabBarRec, TabBarRec} from 'app/client/models/entities/TabBarRec';
import {createTableRec, TableRec} from 'app/client/models/entities/TableRec';
import {createValidationRec, ValidationRec} from 'app/client/models/entities/ValidationRec';
import {createViewFieldRec, ViewFieldRec} from 'app/client/models/entities/ViewFieldRec';
import {createViewRec, ViewRec} from 'app/client/models/entities/ViewRec';
import {createViewSectionRec, ViewSectionRec} from 'app/client/models/entities/ViewSectionRec';
import {CellRec, createCellRec} from 'app/client/models/entities/CellRec';
import {isRefListType, RecalcWhen, RefListValue} from 'app/common/gristTypes';
import {decodeObject} from 'app/plugin/objtypes';
import {Disposable, toKo} from 'grainjs';
import {UIRowId} from 'app/plugin/GristAPI';
import {isNonNullish} from 'app/common/gutil';


// Re-export all the entity types available. The recommended usage is like this:
//    import {ColumnRec, ViewFieldRec} from 'app/client/models/DocModel';
export type {ColumnRec, DocInfoRec, FilterRec, PageRec, TabBarRec, TableRec, ValidationRec,
  ViewFieldRec, ViewRec, ViewSectionRec, CellRec};

/**
 * Creates the type for a MetaRowModel containing a KoSaveableObservable for each field listed in
 * the auto-generated app/common/schema.ts. It represents the metadata record in the database.
 * Particular DocModel entities derive from this, and add other helpful computed values.
 */
export type IRowModel<TName extends keyof SchemaTypes> = MetaRowModel<TName> & {
  [ColId in keyof SchemaTypes[TName]]: KoSaveableObservable<SchemaTypes[TName][ColId]>;
};


/**
 * Returns an observable for an observable array of records from the given table.
 *
 * @param {RowModel} rowModel: RowModel that owns this recordSet.
 * @param {TableModel} tableModel: The model for the table to return records from.
 * @param {String} groupByField: The name of the field in the other table by which to group. The
 *    returned observable arrays will be for the group matching the value of rowModel.id().
 * @param {String} [options.sortBy]: Keep the returned array sorted by this key. If omitted, the
 *    returned array will be sorted by rowId.
 */
export function recordSet<TRow extends MetaRowModel>(
  rowModel: MetaRowModel, tableModel: MetaTableModel<TRow>, groupByField: string, options?: {sortBy: string}
): ko.Computed<KoArray<TRow>> {

  const opts = {groupBy: groupByField, sortBy: 'id', ...options};
  return koUtil.computedAutoDispose(
    () => tableModel.createRowGroupModel(rowModel.id() || 0, opts),
    null, { pure: true });
}


/**
 * Returns an observable for a record from another table, selected using the passed-in observable
 * for a rowId. If rowId is invalid, returns the row model for the fake empty record.
 * @param {TableModel} tableModel: The model for the table to return a record from.
 * @param {ko.observable} rowIdObs: An observable for the row id to look up.
 */
export function refRecord<TRow extends MetaRowModel>(
  tableModel: MetaTableModel<TRow>, rowIdObs: ko.Observable<number>|ko.Computed<number>
): ko.Computed<TRow> {
  // Pass 'true' to getRowModel() to depend on the row version.
  return ko.pureComputed(() => tableModel.getRowModel(rowIdObs() || 0, true));
}


/**
 * Returns an observable with a list of records from another table, selected using RefList column.
 * @param {TableModel} tableModel: The model for the table to return a record from.
 * @param {ko.observable} rowsIdObs: An observable with a RefList value.
 */
export function refListRecords<TRow extends MetaRowModel>(
  tableModel: MetaTableModel<TRow>, rowsIdObs: ko.Observable<RefListValue>|ko.Computed<RefListValue>
) {
  return ko.pureComputed(() => {
    const ids = decodeObject(rowsIdObs()) as number[]|null;
    if (!Array.isArray(ids)) {
      return [];
    }
    return ids.map(id => tableModel.getRowModel(id, true));
  });
}

// Use an alias for brevity.
type MTM<RowModel extends MetaRowModel> = MetaTableModel<RowModel>;

export class DocModel extends Disposable {
  // MTM is a shorthand for MetaTableModel below, to keep each item to one line.
  public docInfo: MTM<DocInfoRec> = this._metaTableModel("_grist_DocInfo", createDocInfoRec);
  public tables: MTM<TableRec> = this._metaTableModel("_grist_Tables", createTableRec);
  public columns: MTM<ColumnRec> = this._metaTableModel("_grist_Tables_column", createColumnRec);
  public views: MTM<ViewRec> = this._metaTableModel("_grist_Views", createViewRec);
  public viewSections: MTM<ViewSectionRec> = this._metaTableModel("_grist_Views_section", createViewSectionRec);
  public viewFields: MTM<ViewFieldRec> = this._metaTableModel("_grist_Views_section_field", createViewFieldRec);
  public tabBar: MTM<TabBarRec> = this._metaTableModel("_grist_TabBar", createTabBarRec);
  public validations: MTM<ValidationRec> = this._metaTableModel("_grist_Validations", createValidationRec);
  public pages: MTM<PageRec> = this._metaTableModel("_grist_Pages", createPageRec);
  public shares: MTM<ShareRec> = this._metaTableModel("_grist_Shares", createShareRec);
  public rules: MTM<ACLRuleRec> = this._metaTableModel("_grist_ACLRules", createACLRuleRec);
  public filters: MTM<FilterRec> = this._metaTableModel("_grist_Filters", createFilterRec);
  public cells: MTM<CellRec> = this._metaTableModel("_grist_Cells", createCellRec);

  public docInfoRow: DocInfoRec;

  public allTables: KoArray<TableRec>;
  public visibleTables: KoArray<TableRec>;
  public rawDataTables: KoArray<TableRec>;
  public rawSummaryTables: KoArray<TableRec>;

  public allTableIds: KoArray<string>;
  public visibleTableIds: KoArray<string>;

  // A mapping from tableId to DataTableModel for user-defined tables.
  public dataTables: {[tableId: string]: DataTableModel} = {};

  // Another map, this one mapping tableRef (rowId) to DataTableModel.
  public dataTablesByRef = new Map<number, DataTableModel>();

  public allTabs: KoArray<TabBarRec> = this.autoDispose(this.tabBar.createAllRowsModel('tabPos'));

  public allPages: ko.Computed<PageRec[]>;
  /** Pages that are shown in the menu. These can include censored pages if they have children. */
  public menuPages: ko.Computed<PageRec[]>;
  // Excludes pages hidden by ACL rules or other reasons (e.g. doc-tour)
  public visibleDocPages: ko.Computed<PageRec[]>;

  // Flag for tracking whether document is in formula-editing mode
  public editingFormula: ko.Observable<boolean> = ko.observable(false);

  // If the doc has a docTour. Used also to enable the UI button to restart the tour.
  public readonly hasDocTour: ko.Computed<boolean>;

  public readonly isTutorial: ko.Computed<boolean>;

  // TODO This is a temporary solution until we expose creation of doc-tours to users. This flag
  // is initialized once on page load. If set, then the tour page (if any) will be visible.
  public showDocTourTable: boolean = (urlState().state.get().docPage === 'GristDocTour');

  // Whether the GristDocTutorial table should be shown. Initialized once on page load.
  public showDocTutorialTable: boolean =
    // We skip subscribing to the observables below since they normally shouldn't change during
    // this object's lifetime. If that changes, this should be made into a computed observable.
    !this._docPageModel?.isTutorialFork.get() ||
    canEdit(this._docPageModel.currentDoc.get()?.trunkAccess ?? null);

  // List of all the metadata tables.
  private _metaTables: Array<MetaTableModel<any>>;

  constructor(public readonly docData: DocData, private readonly _docPageModel?: DocPageModel) {
    super();
    // For all the metadata tables, load their data (and create the RowModels).
    for (const model of this._metaTables) {
      model.loadData();
    }

    this.docInfoRow = this.docInfo.getRowModel(1);

    // An observable array of all tables, sorted by tableId, with no exclusions.
    this.allTables = this.autoDispose(this._createAllTablesArray());

    // An observable array of user-visible tables, sorted by tableId, excluding summary tables.
    // This is a publicly exposed member.
    this.visibleTables = this.autoDispose(this._createVisibleTablesArray());

    // Observable arrays of raw data and summary tables, sorted by tableId.
    this.rawDataTables = this.autoDispose(this._createRawDataTablesArray());
    this.rawSummaryTables = this.autoDispose(this._createRawSummaryTablesArray());

    // An observable array of all tableIds. A shortcut mapped from allTables.
    const allTableIds = this.autoDispose(ko.computed(() => this.allTables.all().map(t => t.tableId())));
    this.allTableIds = koArray.syncedKoArray(allTableIds);

    // An observable array of user-visible tableIds. A shortcut mapped from visibleTables.
    const visibleTableIds = this.autoDispose(ko.computed(() => this.visibleTables.all().map(t => t.tableId())));
    this.visibleTableIds = koArray.syncedKoArray(visibleTableIds);

    // Create an observable array of RowModels for all the data tables. We'll trigger
    // onAddTable/onRemoveTable in response to this array's splice events below.
    const allTableMetaRows = this.autoDispose(this.tables.createAllRowsModel('id'));

    // For a new table, we get AddTable action followed by metadata actions to add a table record
    // (which triggers this subscribeForEach) and to add all the column records. So we have to keep
    // in mind that metadata for columns isn't available yet.
    this.autoDispose(allTableMetaRows.subscribeForEach({
      add: r => this._onAddTable(r),
      remove: r => this._onRemoveTable(r),
    }));

    // Get a list of only the visible pages.
    const allPages = this.autoDispose(this.pages.createAllRowsModel('pagePos'));
    this.allPages = this.autoDispose(ko.computed(() => allPages.all()));
    this.menuPages = this.autoDispose(ko.computed(() => {
      const pagesToShow = this.allPages().filter(p => !p.isSpecial()).sort((a, b) => a.pagePos() - b.pagePos());
      const parent = memoize((page: PageRec) => {
        const myIdentation = page.indentation();
        if (myIdentation === 0) { return null; }
        const idx = pagesToShow.indexOf(page);
        // Find first page starting from before that has lower indentation then mine.
        const beforeMe = pagesToShow.slice(0, idx).reverse();
        return beforeMe.find(p => p.indentation() < myIdentation) ?? null;
      });
      const ancestors = memoize((page: PageRec): PageRec[] => {
        const anc = parent(page);
        return anc ? [anc, ...ancestors(anc)] : [];
      });
      // Helper to test if the page is hidden or is in a hidden branch.
      const hidden = memoize((page: PageRec): boolean => page.isHidden() || ancestors(page).some(p => p.isHidden()));
      return pagesToShow.filter(p => !hidden(p));
    }));
    this.visibleDocPages = this.autoDispose(ko.computed(() => this.allPages().filter(p => !p.isHidden())));

    this.hasDocTour = this.autoDispose(ko.computed(() => this.visibleTableIds.all().includes('GristDocTour')));

    this.isTutorial = this.autoDispose(ko.computed(() =>
      isNonNullish(this._docPageModel)
      && toKo(ko, this._docPageModel.isTutorialFork)()
      && this.allTableIds.all().includes('GristDocTutorial')));
  }

  public getTableModel(tableId: string) {
    return this.dataTables[tableId];
  }

  /**
   * If the given section is the target of linking, collect and return the active rowIDs up the
   * chain of links, returning the list of rowIds starting with the current section's parent. This
   * method is intended for when there is ambiguity such as when RefList linking is involved.
   * In other cases, returns undefined.
   */
  public getLinkingRowIds(sectionId: number): UIRowId[]|undefined {
    const linkingRowIds: UIRowId[] = [];
    let anyAmbiguity = false;
    let section = this.viewSections.getRowModel(sectionId);
    const seen = new Set<number>();
    while (section?.id.peek() && !seen.has(section.id.peek())) {
      seen.add(section.id.peek());
      const rowId = section.activeRowId.peek() || 'new';
      if (isRefListType(section.linkTargetCol.peek().type.peek()) || rowId === 'new') {
        anyAmbiguity = true;
      }
      linkingRowIds.push(rowId);
      section = section.linkSrcSection.peek();
    }
    return anyAmbiguity ? linkingRowIds.slice(1) : undefined;
  }



  // Turn the given columns into empty columns, losing any data stored in them.
  public async clearColumns(colRefs: number[], {keepType}: { keepType?: boolean } = {}): Promise<void> {
    await this.columns.sendTableAction(
      ['BulkUpdateRecord', colRefs, {
        isFormula: colRefs.map(f => true),
        formula: colRefs.map(f => ''),
        ...(keepType ? {} : {
          type: colRefs.map(f => 'Any'),
          widgetOptions: colRefs.map(f => ''),
          visibleCol: colRefs.map(f => null),
          displayCol: colRefs.map(f => null),
          rules: colRefs.map(f => null),
        }),
        // Set recalc settings to defaults when emptying a column.
        recalcWhen: colRefs.map(f => RecalcWhen.DEFAULT),
        recalcDeps: colRefs.map(f => null),
      }]
    );
  }

  // Convert the given columns to data, saving the calculated values and unsetting the formulas.
  public async convertIsFormula(colRefs: number[], opts: { toFormula: boolean, noRecalc?: boolean }): Promise<void> {
    return this.columns.sendTableAction(
      ['BulkUpdateRecord', colRefs, {
        isFormula: colRefs.map(f => opts.toFormula),
        recalcWhen: colRefs.map(f => opts.noRecalc ? RecalcWhen.NEVER : RecalcWhen.DEFAULT),
        recalcDeps: colRefs.map(f => null),
      }]
    );
  }

  // Updates formula for a column.
  public async updateFormula(colRef: number, formula: string): Promise<void> {
    return this.columns.sendTableAction(
      ['UpdateRecord', colRef, {
        formula,
      }]
    );
  }

  // Convert column to pure formula column.
  public async convertToFormula(colRef: number, formula: string): Promise<void> {
    return this.columns.sendTableAction(
      ['UpdateRecord', colRef, {
        isFormula: true,
        formula,
        recalcWhen: RecalcWhen.DEFAULT,
        recalcDeps: null,
      }]
    );
  }

  // Convert column to data column with a trigger formula
  public async convertToTrigger(
    colRefs: number,
    formula: string,
    recalcWhen: RecalcWhen = RecalcWhen.DEFAULT ): Promise<void> {
    return this.columns.sendTableAction(
      ['UpdateRecord', colRefs, {
        isFormula: false,
        formula,
        recalcWhen: recalcWhen,
        recalcDeps: null,
      }]
    );
  }

  private _metaTableModel<TName extends keyof SchemaTypes, TRow extends IRowModel<TName>>(
    tableId: TName,
    rowConstructor: (this: TRow, docModel: DocModel) => void,
  ): MetaTableModel<TRow> {
    const fields = Object.keys(schema[tableId]);
    const model = new MetaTableModel<TRow>(this, this.docData.getTable(tableId)!, fields, rowConstructor);
    // To keep _metaTables private member listed after public ones, initialize it on first use.
    if (!this._metaTables) { this._metaTables = []; }
    this._metaTables.push(model);
    return this.autoDispose(model);
  }

  private _onAddTable(tableMetaRow: TableRec) {
    let tid = tableMetaRow.tableId();
    const dtm = new DataTableModel(this, this.docData.getTable(tid)!, tableMetaRow);
    this.dataTables[tid] = dtm;
    this.dataTablesByRef.set(tableMetaRow.getRowId(), dtm);

    // Subscribe to tableMetaRow.tableId() to handle table renames.
    tableMetaRow.tableId.subscribe(newTableId => {
      this.dataTables[newTableId] = this.dataTables[tid];
      delete this.dataTables[tid];
      tid = newTableId;
    });
  }

  private _onRemoveTable(tableMetaRow: TableRec) {
    const tid = tableMetaRow.tableId();
    this.dataTables[tid].dispose();
    delete this.dataTables[tid];
    this.dataTablesByRef.delete(tableMetaRow.getRowId());
  }

  /**
   * Returns an observable array of all tables, sorted by tableId.
   */
  private _createAllTablesArray(): KoArray<TableRec> {
    return createTablesArray(this.tables);
  }

  /**
   * Returns an observable array of user tables, sorted by tableId, and excluding hidden/summary
   * tables.
   */
  private _createVisibleTablesArray(): KoArray<TableRec> {
    return createTablesArray(this.tables, r =>
      !isHiddenTable(this.tables.tableData, r) &&
      !isVirtualTable(this.tables.tableData, r) &&
      (!isTutorialTable(this.tables.tableData, r) || this.showDocTutorialTable)
    );
  }

  /**
   * Returns an observable array of raw data tables, sorted by tableId, and excluding summary
   * tables.
   */
  private _createRawDataTablesArray(): KoArray<TableRec> {
    return createTablesArray(this.tables, r =>
      !isSummaryTable(this.tables.tableData, r) &&
      (!isTutorialTable(this.tables.tableData, r) || this.showDocTutorialTable)
    );
  }

  /**
   * Returns an observable array of raw summary tables, sorted by tableId.
   */
  private _createRawSummaryTablesArray(): KoArray<TableRec> {
    return createTablesArray(this.tables, r => isSummaryTable(this.tables.tableData, r));
  }
}

/**
 * Creates an observable array of tables, sorted by tableId.
 *
 * An optional `filterFunc` may be specified to filter tables.
 */
function createTablesArray(
  tablesModel: MetaTableModel<TableRec>,
  filterFunc: RowFilterFunc<UIRowId> = (_row) => true
) {
  const rowSource = new rowset.FilteredRowSource(filterFunc);
  rowSource.subscribeTo(tablesModel);
  // Create an observable RowModel array based on this rowSource, sorted by tableId.
  return tablesModel._createRowSetModel(rowSource, 'tableId');
}

/**
 * Return whether a table (identified by the rowId of its metadata record) is
 * the special GristDocTutorial table.
 */
function isTutorialTable(tablesData: TableData, tableRef: UIRowId): boolean {
  return tablesData.getValue(tableRef, 'tableId') === 'GristDocTutorial';
}

/**
 * Check whether a table is virtual - currently that is done
 * by having a string rowId rather than the expected integer.
 */
function isVirtualTable(tablesData: TableData, tableRef: UIRowId): boolean {
  return typeof(tableRef) === 'string';
}
